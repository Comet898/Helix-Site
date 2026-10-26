/*
 * Transport adapters for Scramjet v2.
 *
 * epoxy.mjs and libcurl.mjs are "bare-mux style" transports: request headers go in as a plain
 * object and come back as an object (libcurl: name -> [values]). Scramjet v2 talks to its
 * transport with raw header lists ([[name, value], ...]) and needs the response headers in the
 * same shape, one pair per Set-Cookie. AdapterTransport converts between the two.
 *
 * FallbackTransport tries a primary transport and, when the connection itself fails (for example
 * epoxy's "tls handshake eof", which some sites such as TikTok trigger), retries on a second one
 * and remembers which transport works for that host.
 */
(function (root) {
  "use strict";

  const errText = (e) => String((e && (e.message || e.reason)) || e || "");

  /* any header container -> [[name, value], ...] (one pair per value, Set-Cookie split) */
  function toPairs(h) {
    const out = [];
    const push = (k, v) => {
      k = String(k); v = String(v);
      if (k.toLowerCase() === "set-cookie" && v.indexOf(",") >= 0) {
        for (const c of v.split(/,(?=\s*[^;,=\s]+=)/)) out.push([k, c.trim()]);
      } else out.push([k, v]);
    };
    if (!h) return out;
    if (Array.isArray(h)) { for (const p of h) if (p && p.length >= 2) push(p[0], p[1]); return out; }
    if (typeof h.entries === "function" && typeof h.get === "function") { for (const p of h.entries()) push(p[0], p[1]); return out; }
    for (const k of Object.keys(h)) {
      const v = h[k];
      if (Array.isArray(v)) v.forEach((x) => push(k, x)); else if (v != null) push(k, v);
    }
    return out;
  }

  /* [[name, value], ...] -> { name: value } (repeated names are joined) */
  function toObj(h) {
    const o = {}, seen = {};
    for (const [k, v] of toPairs(h)) {
      const l = k.toLowerCase();
      if (seen[l] === undefined) { seen[l] = k; o[k] = v; }
      else o[seen[l]] += (l === "cookie" ? "; " : ", ") + v;
    }
    return o;
  }

  /* streamed request bodies are buffered so a failed request can be retried */
  async function normBody(body) {
    if (body == null) return body;
    if (typeof body.getReader === "function") return await new Response(body).arrayBuffer();
    if (typeof Blob !== "undefined" && body instanceof Blob) return await body.arrayBuffer();
    return body;
  }

  const SAFE = /^(GET|HEAD|OPTIONS)$/i;
  /* the Wisp connection can drop at any time (server restart, idle timeout, host limits). epoxy then reports
     "Wisp: MuxTaskEnded" for everything that follows, so the transport is rebuilt and the websockets that were
     riding on it are closed, which makes sites such as Discord reconnect by themselves */
  const MUX = /MuxTaskEnded|Multiplexor|mux task|Wisp.{0,30}(closed|ended|lost)/i;

  class AdapterTransport {
    constructor(inner, label, factory) {
      this.inner = inner;
      this.label = label || "transport";
      this.factory = factory || null;
      this.ready = false;
      this.dead = false;
      this.sockets = new Set();
      AdapterTransport.all.add(this);
    }
    async init() {
      if (!this.inner.ready) await this.inner.init();
      this.ready = true;
    }
    async meta() {}
    markDead() {
      if (!this.factory) return;
      this.dead = true;
      const list = Array.from(this.sockets); this.sockets.clear();
      for (const f of list) { try { f(1006, "Wisp connection lost"); } catch (e) {} }
    }
    async revive() {
      if (this.reviving) return this.reviving;
      this.reviving = (async () => {
        try {
          const n = await this.factory();
          if (!n.ready) await n.init();
          this.inner = n; this.dead = false;
        } finally { this.reviving = null; }
      })();
      return this.reviving;
    }
    async request(remote, method, body, headers, signal) {
      body = await normBody(body);
      const h = toObj(headers);
      if (this.dead) await this.revive();
      for (let attempt = 0; ; attempt++) {
        try {
          const r = await this.inner.request(remote, method, body, h, signal);
          return { body: r.body, headers: toPairs(r.headers), status: r.status, statusText: r.statusText };
        } catch (e) {
          const t = errText(e);
          if (!this.factory || !MUX.test(t)) throw e;
          this.markDead();
          if (attempt > 0 || !(SAFE.test(method || "GET") || /\bConnect\b/.test(t))) throw e;
          await this.revive();
        }
      }
    }
    connect(url, protocols, requestHeaders, onopen, onmessage, onclose, onerror) {
      const hdr = toObj(requestHeaders);
      let closed = false;
      const track = (rec) => { this.sockets.add(rec); return rec; };
      const open = () => {
        const rec = track((code, reason) => { if (closed) return; closed = true; onclose && onclose(code, reason); });
        const res = this.inner.connect(
          url, protocols, hdr,
          (protocol, extensions) => onopen(protocol || "", extensions || ""),
          onmessage,
          (code, reason) => { this.sockets.delete(rec); if (!closed) { closed = true; onclose && onclose(code, reason); } },
          (m) => { if (MUX.test(errText(m))) this.markDead(); onerror && onerror(m); }
        );
        if (res && typeof res.catch === "function") res.catch((e) => { if (MUX.test(errText(e))) this.markDead(); if (!closed) { closed = true; onerror && onerror(errText(e)); } });
        return res;
      };
      if (!this.dead) { try { return open(); } catch (e) { if (MUX.test(errText(e))) this.markDead(); else throw e; } }
      const p = (async () => { await this.revive(); return await open(); })();
      p.catch((e) => { try { onerror && onerror(errText(e)); } catch (x) {} });
      return [async (d) => (await p)[0](d), async (c, r) => (await p)[1](c, r)];
    }
  }
  AdapterTransport.all = new Set();
  const markAllDead = () => { for (const t of AdapterTransport.all) t.markDead(); };

    function retryable(method, err) {
    if (err && err.name === "AbortError") return false;
    if (SAFE.test(method || "GET")) return true;
    /* never replay a POST unless the failure happened while connecting */
    return /handshake|\btls\b|certificate|\bConnect\b|dns|resolve|refused|unreachable/i.test(errText(err));
  }

  class FallbackTransport {
    /* primary: AdapterTransport, secondaryFactory: () => Promise<AdapterTransport> */
    constructor(primary, secondaryFactory, log) {
      this.primary = primary;
      this.secondaryFactory = secondaryFactory;
      this.secondary = null;
      this.log = log || function () {};
      this.ready = false;
      this.prefs = new Map();
      this.label = "auto";
    }
    async init() {
      try { await this.primary.init(); }
      catch (e) {
        this.log("warn", "transport", this.primary.label + " could not start (" + errText(e).slice(0, 160) + "), using the other transport");
        await this.getSecondary();
        this.primaryDown = true;
      }
      this.ready = true;
    }
    async meta() {}
    async getSecondary() {
      if (!this.secondary) this.secondary = await this.secondaryFactory();
      if (!this.secondary.ready) await this.secondary.init();
      return this.secondary;
    }
    prefers(host) {
      if (this.primaryDown) return "secondary";
      const p = this.prefs.get(host);
      if (!p) return "primary";
      if (p.until < Date.now()) { this.prefs.delete(host); return "primary"; }
      return p.which;
    }
    async get(which) {
      return which === "primary" ? (this.primaryDown ? null : this.primary) : await this.getSecondary();
    }
    async request(remote, method, body, headers, signal) {
      const host = remote.hostname;
      body = await normBody(body);
      const first = this.prefers(host);
      const order = first === "primary" ? ["primary", "secondary"] : ["secondary", "primary"];
      let lastErr = null;
      for (let i = 0; i < order.length; i++) {
        let t;
        try { t = await this.get(order[i]); } catch (e) { lastErr = e; continue; }
        if (!t) continue;
        try {
          const r = await t.request(remote, method, body, headers, signal);
          if (i > 0) {
            this.prefs.set(host, { which: order[i], until: Date.now() + 10 * 60 * 1000 });
            this.log("info", "transport", host + " loaded through " + t.label + " after " + order[0] + " failed");
          }
          return r;
        } catch (e) {
          lastErr = e;
          const more = i < order.length - 1;
          this.log("warn", "transport", t.label + " failed for " + host + ": " + errText(e).slice(0, 220) + (more && retryable(method, e) ? " (retrying with the other transport)" : ""));
          if (!more || !retryable(method, e)) break;
        }
      }
      throw lastErr || new Error("No transport available");
    }
    connect(url, protocols, requestHeaders, onopen, onmessage, onclose, onerror) {
      const wantSecondary = this.prefers(url.hostname) === "secondary" && this.secondary && this.secondary.ready;
      const t = wantSecondary ? this.secondary : (this.primaryDown && this.secondary ? this.secondary : this.primary);
      return t.connect(url, protocols, requestHeaders, onopen, onmessage, onclose, onerror);
    }
  }

  /* Tries the same request through several Wisp servers. When one cannot reach a site (for example
     "SSL connect error" / "tls handshake eof"), the next server is used and remembered per host. */
  class WispPoolTransport {
    constructor(urls, factory, log) {
      this.urls = urls; this.factory = factory; this.log = log || function () {};
      this.ts = new Map(); this.bad = new Map(); this.prefs = new Map();
      this.ready = false; this.label = "pool";
    }
    async get(i) {
      let p = this.ts.get(i);
      if (!p) {
        p = (async () => { const t = await this.factory(this.urls[i]); if (!t.ready) await t.init(); return t; })();
        this.ts.set(i, p);
        p.catch(() => this.ts.delete(i));
      }
      return p;
    }
    async init() {
      let err = null;
      for (let i = 0; i < this.urls.length; i++) {
        try { await this.get(i); this.cur = i; this.ready = true; return; } catch (e) { err = e; }
      }
      throw err || new Error("No transport available");
    }
    async meta() {}
    /* A host stays on the Wisp server that first served it: sites such as Cloudflare tie a challenge to the IP address,
       so hopping to another server in the middle of a session restarts the challenge (and fails the request in flight). */
    pinned(host) {
      const p = this.prefs.get(host);
      return p && p.until > Date.now() ? p.i : -1;
    }
    order(host) {
      const n = this.urls.length, now = Date.now(), pin = this.pinned(host);
      const first = pin >= 0 ? pin : (this.cur || 0);
      const rest = []; for (let i = 0; i < n; i++) if (i !== first) rest.push(i);
      const good = rest.filter(i => !(this.bad.get(i) > now)), bad = rest.filter(i => this.bad.get(i) > now);
      if (pin >= 0) return [first].concat(good, bad);            /* pinned server first, whatever its health mark */
      const all = [first].concat(rest);
      return all.filter(i => !(this.bad.get(i) > now)).concat(all.filter(i => this.bad.get(i) > now));
    }
    async request(remote, method, body, headers, signal) {
      const host = remote.hostname, path = remote.pathname || "";
      body = await normBody(body);
      const order = this.order(host), safe = SAFE.test(method || "GET"), cf = /^\/cdn-cgi\//.test(path);
      let lastErr = null, tries = 0, askedMore = false;
      outer: for (let k = 0; k < order.length && tries < 6; k++) {
        const i = order[k];
        let again = 0;
        for (;;) {
          const pinnedHere = this.pinned(host) === i;
          try {
            tries++;
            const t = await Promise.race([this.get(i), new Promise((_, rej) => setTimeout(() => rej(new Error("Wisp transport start timed out")), 15000))]);
            const r = await Promise.race([t.request(remote, method, body, headers, signal), new Promise((_, rej) => setTimeout(() => rej(new Error("Wisp request timed out (connect)")), 25000))]);
            if (k > 0) this.log("info", "wisp", host + " loaded through " + this.urls[i]);
            this.prefs.set(host, { i, until: Date.now() + 30 * 60 * 1000 });   /* pin (or refresh the pin) */
            this.bad.delete(i);
            return r;
          } catch (e) {
            lastErr = e;
            const timeout = /timed out/i.test(errText(e));
            if (timeout) this.bad.set(i, Date.now() + 2 * 60 * 1000);
            /* only one server known so far (others are still being probed): wait for them once, then keep going */
            if (k >= order.length - 1 && this.onNeedMore && !askedMore && !timeout && (safe || retryable(method, e))) {
              askedMore = true;
              try { await this.onNeedMore(); } catch (x) {}
              for (const j of this.order(host)) if (!order.includes(j)) order.push(j);
            }
            const more = k < order.length - 1;
            /* a timed-out GET is tried once more on the same server before another server (another IP) is used */
            const sameAgain = timeout && safe && pinnedHere && again < 1;
            /* never replay a POST/PUT after a timeout (it may already have been processed), and never move a Cloudflare
               challenge request (/cdn-cgi/) to another IP: the challenge belongs to the IP that received it */
            const hop = more && !(pinnedHere && cf) && (timeout ? safe : retryable(method, e));
            this.log("warn", "wisp", this.urls[i] + " failed for " + host + ": " + errText(e).slice(0, 160) +
              (sameAgain ? " (trying the same server once more)" : hop ? " (trying next server)" : (pinnedHere && cf ? " (kept on this server: Cloudflare challenge request)" : more && !safe && timeout ? " (not repeated: " + method + " request)" : "")));
            if (sameAgain) { again++; continue; }
            if (!hop) break outer;
            break;
          }
        }
      }
      throw lastErr || new Error("No transport available");
    }
    connect(url, protocols, requestHeaders, onopen, onmessage, onclose, onerror) {
      /* Scramjet expects [send, close] back, exactly like the plain transports return */
      const order = this.order(url.hostname);
      const innerP = (async () => {
        let lastErr = null;
        for (const i of order.slice(0, 3)) {
          try {
            const t = await Promise.race([this.get(i), new Promise((_, rej) => setTimeout(() => rej(new Error("Wisp transport start timed out")), 15000))]);
            return await t.connect(url, protocols, requestHeaders, onopen, onmessage, onclose, onerror);
          } catch (e) { lastErr = e; this.log("warn", "wisp", this.urls[i] + " websocket failed: " + errText(e).slice(0, 160)); }
        }
        throw lastErr || new Error("No transport available");
      })();
      innerP.catch((e) => { try { onerror && onerror(errText(e)); } catch (x) {} });
      return [
        async (data) => { const r = await innerP; return r[0](data); },
        async (code, reason) => { const r = await innerP; return r[1](code, reason); }
      ];
    }
  }

  const api = { MUX, markAllDead, toPairs, toObj, normBody, retryable, AdapterTransport, FallbackTransport, WispPoolTransport };
  root.HZTransport = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof self !== "undefined" ? self : globalThis);
