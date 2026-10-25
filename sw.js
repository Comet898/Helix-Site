// Custom service-worker web proxy: libcurl.js (WASM) + Wisp transport,
// with a cookie jar, AST-based JS rewriting and a faked window.location.
const Q = new URL(self.location).searchParams;
const WISP = Q.get("wisp") || "wss://motor-cycle-part.org/";
importScripts(
  Q.get("libcurl") || "https://cdn.jsdelivr.net/npm/libcurl.js@0.7.4/libcurl_full.js",
  Q.get("acorn") || "https://cdn.jsdelivr.net/npm/acorn@8.14.0/dist/acorn.js"
);
importScripts("sj/hz-cors.js");   /* CORS base, see sj/hz-cors.js */
const P = new URL("./", self.location).pathname + "service/";

/* ---------- cookie jar (persisted in IndexedDB) ---------- */
const jar = new Map();
const idb = (mode, fn) => new Promise((res, rej) => {
  const o = indexedDB.open("hzproxy", 1);
  o.onupgradeneeded = () => o.result.createObjectStore("kv");
  o.onerror = () => rej(o.error);
  o.onsuccess = () => {
    const t = o.result.transaction("kv", mode), r = fn(t.objectStore("kv"));
    t.oncomplete = () => res(r && r.result); t.onerror = () => rej(t.error);
  };
});
let saveT;
const saveJar = () => { clearTimeout(saveT); saveT = setTimeout(() => idb("readwrite", s => s.put([...jar.values()], "jar")).catch(() => {}), 200); };
const ckey = c => c.domain + "|" + c.path + "|" + c.name;

function setCookie(line, url) {
  const u = new URL(url), [nv, ...attrs] = line.split(";"), i = nv.indexOf("=");
  if (i < 1) return;
  const c = { name: nv.slice(0, i).trim(), value: nv.slice(i + 1).trim(), domain: u.hostname, hostOnly: true,
              path: u.pathname.replace(/[^/]*$/, "") || "/", expires: null, secure: false, httpOnly: false };
  let maxAge = null;
  for (const a of attrs) {
    const [k0, ...vv] = a.split("="), k = k0.trim().toLowerCase(), v = vv.join("=").trim();
    if (k === "domain" && v) { c.domain = v.replace(/^\./, "").toLowerCase(); c.hostOnly = false; }
    else if (k === "path" && v[0] === "/") c.path = v;
    else if (k === "max-age") maxAge = Date.now() + (+v) * 1000;
    else if (k === "expires") c.expires = Date.parse(v) || null;
    else if (k === "secure") c.secure = true;
    else if (k === "httponly") c.httpOnly = true;
  }
  if (maxAge !== null) c.expires = maxAge;
  if (u.hostname !== c.domain && !u.hostname.endsWith("." + c.domain)) return;
  if (c.expires !== null && c.expires <= Date.now()) jar.delete(ckey(c)); else jar.set(ckey(c), c);
  saveJar();
}
const splitCookies = s => s ? s.split(/,(?=\s*[^;,=\s]+=)/) : [];
function cookieHeader(url, forJs) {
  const u = new URL(url), now = Date.now();
  return [...jar.values()].filter(c =>
    (c.expires === null || c.expires > now) &&
    (c.hostOnly ? u.hostname === c.domain : (u.hostname === c.domain || u.hostname.endsWith("." + c.domain))) &&
    u.pathname.startsWith(c.path) && (!c.secure || u.protocol === "https:") && !(forJs && c.httpOnly))
    .sort((a, b) => b.path.length - a.path.length).map(c => c.name + "=" + c.value).join("; ");
}

/* ---------- boot ---------- */
const ready = (async () => {
  await new Promise(res => { const d = () => { libcurl.set_websocket(WISP); res(); }; libcurl.ready ? d() : (libcurl.onload = d); });
  try { for (const c of (await idb("readonly", s => s.get("jar"))) || []) jar.set(ckey(c), c); } catch (e) {}
})();
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", e => e.waitUntil(self.clients.claim()));

/* ---------- URL helpers ---------- */
const px = (u, base) => {
  try {
    const a = new URL(u, base);
    if (!/^https?:$/.test(a.protocol)) return u;
    const h = a.hash; a.hash = "";
    return P + encodeURIComponent(a.href) + h;
  } catch { return u; }
};
const unpx = u => { try { const a = new URL(u); return a.origin === location.origin && a.pathname.startsWith(P) ? decodeURIComponent(a.pathname.slice(P.length)) : null; } catch { return null; } };

const rewriteCss = (css, base) =>
  css.replace(/url\(\s*(['"]?)(.*?)\1\s*\)/gi, (m, q, u) => /^(data:|#)/i.test(u) ? m : `url(${q}${px(u, base)}${q})`)
     .replace(/@import\s+(['"])(.*?)\1/gi, (m, q, u) => `@import ${q}${px(u, base)}${q}`);

/* ---------- JS rewriting: location -> faked location ---------- */
const JS_PRE = "typeof __hzL==='undefined'&&(self.__hzL=function(o){return o.location},self.__hzloc=self.location);";
function rewriteJs(src) {
  let ast;
  try { ast = acorn.parse(src, { ecmaVersion: "latest", sourceType: "script", allowReturnOutsideFunction: true, allowHashBang: true }); }
  catch (e) { try { ast = acorn.parse(src, { ecmaVersion: "latest", sourceType: "module", allowHashBang: true }); } catch (e2) { return src; } }
  const edits = [], ids = []; let bound = false;
  const visit = (n, parent, key) => {
    if (n.type === "Identifier" && n.name === "location") {
      const t = parent && parent.type;
      if (!parent) return;
      if (t === "MemberExpression" && key === "property" && !parent.computed) return;
      if ((t === "Property" || t === "MethodDefinition" || t === "PropertyDefinition") && key === "key" && !parent.computed) return;
      if ((t === "VariableDeclarator" && key === "id") || (/Function/.test(t) && (key === "params" || key === "id")) ||
          (t === "CatchClause" && key === "param") || (t === "ClassDeclaration" && key === "id")) { bound = true; return; }
      if (/^(Labeled|Break|Continue|ImportSpecifier|ExportSpecifier)/.test(t)) return;
      ids.push([n, parent, key]); return;
    }
    if (n.type === "MemberExpression" && !n.computed && n.property.name === "location") {
      const left = parent && parent.type === "AssignmentExpression" && parent.left === n;
      edits.push([n.start, n.start, "__hzL("], [n.object.end, n.end, left ? ").href" : ")"]);
    }
    for (const k in n) {
      if (k === "type" || k === "start" || k === "end") continue;
      const v = n[k];
      if (Array.isArray(v)) { for (const c of v) if (c && typeof c.type === "string") visit(c, n, k); }
      else if (v && typeof v.type === "string") visit(v, n, k);
    }
  };
  try { visit(ast, null, null); } catch (e) { return src; }
  if (!bound) for (const [n, parent, key] of ids) {
    const left = parent.type === "AssignmentExpression" && parent.left === n;
    edits.push([n.start, n.end, left ? "__hzloc.href" : (parent.type === "Property" && parent.shorthand && key === "value") ? "location: __hzloc" : "__hzloc"]);
  }
  if (!edits.length) return JS_PRE + src;
  edits.sort((a, b) => b[0] - a[0] || b[1] - a[1]);
  let out = src;
  for (const [s, e, r] of edits) out = out.slice(0, s) + r + out.slice(e);
  return JS_PRE + out;
}

/* ---------- injected client shim (runs in the proxied page) ---------- */
function shimMain(P, CK) {
  const cur = () => { try { return new URL(decodeURIComponent(location.pathname.slice(P.length)) + location.hash); } catch (e) { return new URL("about:blank"); } };
  const px = u => { if (typeof u === "string" && u.startsWith(P)) return u; try { const a = new URL(u, cur().href); if (!/^https?:$/.test(a.protocol)) return u; if (a.origin === location.origin && a.pathname.startsWith(P)) return u; const h = a.hash; a.hash = ""; return P + encodeURIComponent(a.href) + h; } catch (e) { return u; } };
  const nav = (v, rep) => { const t = px(String(v)); rep ? location.replace(t) : location.assign(t); };
  const L = {};
  for (const k of ["href", "origin", "protocol", "host", "hostname", "port", "pathname", "search", "hash"])
    Object.defineProperty(L, k, { enumerable: true, get: () => cur()[k], set: v => { if (k === "hash") location.hash = v; else if (k === "href") nav(v); else { const u = cur(); u[k] = v; nav(u.href); } } });
  Object.assign(L, { assign: v => nav(v), replace: v => nav(v, 1), reload: () => location.reload(), toString: () => cur().href, ancestorOrigins: [] });
  L[Symbol.toPrimitive] = () => cur().href;
  window.__hzloc = L;
  window.__hzL = o => (o === window || o === document || o === top || o === parent) ? L : o.location;
  for (const [k, f] of [["URL", () => cur().href], ["documentURI", () => cur().href], ["baseURI", () => cur().href], ["domain", () => cur().hostname]])
    try { Object.defineProperty(Document.prototype, k, { get: f, set() {}, configurable: true }); } catch (e) {}
  const xo = XMLHttpRequest.prototype.open, xs = XMLHttpRequest.prototype.send, of = window.fetch;
  let ck = CK; const pend = new Set();
  const post = v => { const p = of.call(window, P + "__cookie?u=" + encodeURIComponent(cur().href), { method: "POST", body: v, keepalive: true }).catch(() => {}).finally(() => pend.delete(p)); pend.add(p); };
  const setLocal = v => {
    const [nv, ...at] = String(v).split(";"), i = nv.indexOf("="); if (i < 1) return;
    const n = nv.slice(0, i).trim(), m = new Map(ck ? ck.split("; ").map(s => [s.slice(0, s.indexOf("=")), s]) : []);
    let dead = false;
    for (const a of at) { const [k, ...vv] = a.split("="), x = vv.join("=").trim(), kk = k.trim().toLowerCase(); if ((kk === "max-age" && +x <= 0) || (kk === "expires" && Date.parse(x) <= Date.now())) dead = true; }
    dead ? m.delete(n) : m.set(n, n + "=" + nv.slice(i + 1).trim()); ck = [...m.values()].join("; ");
  };
  try { Object.defineProperty(Document.prototype, "cookie", { get: () => ck, set: v => { setLocal(v); post(String(v)); }, configurable: true }); } catch (e) {}
  const upd = h => { if (h !== null) ck = decodeURIComponent(h); };
  window.fetch = function (i, o) {
    const a = (typeof i === "string" || i instanceof URL) ? px(String(i)) : i;
    const go = () => of.call(this, a, o).then(r => { upd(r.headers.get("x-hz-ck")); return r; });
    return pend.size ? Promise.all([...pend]).then(go) : go();
  };
  XMLHttpRequest.prototype.open = function (m, u, a, ...r) { this.__hzSync = a === false; return xo.call(this, m, px(String(u)), a === undefined ? true : a, ...r); };
  XMLHttpRequest.prototype.send = function (b) {
    this.addEventListener("loadend", () => upd(this.getResponseHeader("x-hz-ck")));
    if (pend.size && !this.__hzSync) { Promise.all([...pend]).then(() => xs.call(this, b)); return; }
    return xs.call(this, b);
  };
  const real = h => h.startsWith(P) ? decodeURIComponent(h.slice(P.length)) : new URL(h, cur().href).href;
  const wo = window.open;
  window.open = function (u, ...r) {
    if (u && window.parent !== window) { try { parent.postMessage({ hzOpen: real(String(u)) }, location.origin); return null; } catch (e) {} }
    return wo.call(this, u ? px(String(u)) : u, ...r);
  };
  document.addEventListener("click", e => {
    const a = e.target.closest && e.target.closest("a[target=_blank]");
    if (a && a.getAttribute("href") && window.parent !== window && !e.defaultPrevented) { e.preventDefault(); parent.postMessage({ hzOpen: real(a.getAttribute("href")) }, location.origin); }
  }, true);
  if (navigator.sendBeacon) { const sb = navigator.sendBeacon; navigator.sendBeacon = function (u, d) { return sb.call(this, px(String(u)), d); }; }
  const WSC = { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 };
  window.WebSocket = Object.assign(function (u, pr) {
    const L = parent.libcurl;
    if (!L || !L.WebSocket) throw new DOMException("Proxy transport is not ready", "InvalidStateError");
    const a = new URL(String(u), cur().href);
    if (a.protocol === "http:") a.protocol = "ws:"; else if (a.protocol === "https:") a.protocol = "wss:";
    return pr === undefined ? new L.WebSocket(a.href) : new L.WebSocket(a.href, pr);
  }, WSC);
  const W = window.Worker; if (W) window.Worker = class extends W { constructor(u, o) { super(px(String(u)), o); } };
  for (const k of ["pushState", "replaceState"]) { const f = history[k]; history[k] = function (s, t, u) { return f.call(this, s, t, u ? px(String(u)) : u); }; }
  const sa = Element.prototype.setAttribute; Element.prototype.setAttribute = function (n, v) { if (/^(src|href|action|poster)$/i.test(n)) v = px(String(v)); return sa.call(this, n, v); };
  for (const [C, p] of [[HTMLScriptElement, "src"], [HTMLImageElement, "src"], [HTMLIFrameElement, "src"], [HTMLLinkElement, "href"], [HTMLAnchorElement, "href"], [HTMLSourceElement, "src"], [HTMLMediaElement, "src"], [HTMLFormElement, "action"]]) {
    const d = Object.getOwnPropertyDescriptor(C.prototype, p);
    if (d && d.set) Object.defineProperty(C.prototype, p, { get: d.get, set(v) { d.set.call(this, px(String(v))); }, configurable: true });
  }
}
const shimTag = ck => "<script>(" + shimMain.toString() + ")(" + JSON.stringify(P) + "," + JSON.stringify(ck) + ")<\/script>";

const ATTR = /\b(src|href|action|poster)=("|')(.*?)\2/gi;
const rewriteHtml = (html, base) => {
  html = html
    .replace(/<meta[^>]+http-equiv=["']?content-security-policy[^>]*>/gi, "")
    .replace(/<base\b[^>]*>/gi, "")
    .replace(/(<script\b(?![^>]*\bsrc\s*=)[^>]*>)([\s\S]*?)(<\/script>)/gi, (m, a, js, c) =>
      /type\s*=\s*["']?(application\/(ld\+)?json|text\/template|importmap|speculationrules)/i.test(a) ? m : a + rewriteJs(js) + c)
    .replace(/<[a-zA-Z][^>]*>/g, tag => tag.replace(/\s(integrity|nonce)=("[^"]*"|'[^']*')/gi, "").replace(ATTR, (m, a, q, v) => `${a}=${q}${px(v, base)}${q}`))
    .replace(/(<style[^>]*>)([\s\S]*?)(<\/style>)/gi, (m, a, css, c) => a + rewriteCss(css, base) + c);
  return /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, m => m + shimTag(cookieHeader(base, true))) : shimTag(cookieHeader(base, true)) + html;
};

/* ---------- request handling ---------- */
const KEEP = ["accept", "accept-language", "content-type", "range", "if-none-match", "if-modified-since"];
async function handle(req, target) {
  await ready;
  const headers = {};
  for (const [k, v] of req.headers) if (KEEP.includes(k.toLowerCase())) headers[k] = v;
  const ck = cookieHeader(target); if (ck) headers.Cookie = ck;
  const ref = req.referrer && unpx(req.referrer);
  if (ref) { headers.Referer = ref; if (!/^(GET|HEAD)$/.test(req.method)) headers.Origin = new URL(ref).origin; }
  const init = { method: req.method, headers, redirect: "manual" };
  if (!/^(GET|HEAD)$/.test(req.method)) init.body = await req.arrayBuffer();
  try {
    const r = await Promise.race([libcurl.fetch(target, init), new Promise((_, rej) => setTimeout(() => rej(new Error("Timed out. The Wisp server is down or too slow. Change it in Settings.")), 30000))]);
    for (const c of (r.headers.getSetCookie ? r.headers.getSetCookie() : splitCookies(r.headers.get("set-cookie")))) setCookie(c, target);
    const out = new Headers();
    for (const [k, v] of r.headers) {
      if (/^(content-security-policy.*|x-frame-options|content-encoding|content-length|set-cookie|transfer-encoding|location)$/i.test(k)) continue;
      try { out.set(k, v); } catch {}
    }
    HzCors.apply(out, req);
    out.set("x-hz-ck", encodeURIComponent(cookieHeader(ref || target, true)));
    const loc = r.headers.get("location");
    if (r.status >= 300 && r.status < 400 && loc) { out.set("location", px(loc, target)); return new Response(null, { status: r.status, headers: out }); }
    const type = r.headers.get("content-type") || "";
    if (/html/i.test(type)) return new Response(rewriteHtml(await r.text(), target), { status: r.status, headers: out });
    if (/text\/css/i.test(type)) return new Response(rewriteCss(await r.text(), target), { status: r.status, headers: out });
    if (/javascript|ecmascript/i.test(type) || req.destination === "script")
      return new Response(rewriteJs(await r.text()), { status: r.status, headers: out });
    return new Response(await r.arrayBuffer(), { status: r.status, headers: out });
  } catch (e) { return new Response("<body style=\"font:15px system-ui;padding:40px;max-width:560px;margin:auto\"><h2>Could not load this page</h2><p style=\"color:#a33\">" + String(e && e.message || e).replace(/</g, "&lt;") + "</p></body>", { status: 502, headers: { "content-type": "text/html" } }); }
}

async function cookieApi(req, u) {
  await ready;
  const real = u.searchParams.get("u");
  if (req.method === "POST") { setCookie(await req.text(), real); return new Response(""); }
  return new Response(cookieHeader(real, true));
}

self.addEventListener("fetch", e => {
  const u = new URL(e.request.url);
  if (u.origin !== location.origin || !u.pathname.startsWith(P)) return;
  const pf = HzCors.preflight(e.request); if (pf) return e.respondWith(pf);
  if (u.pathname === P + "__cookie") return e.respondWith(cookieApi(e.request, u));
  if (u.pathname === P + "__ping") return e.respondWith(new Response("ok", { headers: { "cache-control": "no-store" } }));
  let target = decodeURIComponent(u.pathname.slice(P.length));
  if (!/^[a-z][a-z0-9+.-]*:/i.test(target)) {
    const base = unpx(e.request.referrer);
    if (!base) return e.respondWith(new Response("Bad proxy URL", { status: 400 }));
    try { target = new URL(target + u.search, base).href; } catch { return e.respondWith(new Response("Bad proxy URL", { status: 400 })); }
  }
  e.respondWith(handle(e.request, target));
});
