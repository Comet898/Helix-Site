/* Scramjet v2 service worker.
   controller.sw.js registers the install/activate handlers and exposes
   $scramjetController.shouldRoute(event) / route(event). */
importScripts("controller/controller.sw.js");
importScripts("hz-cors.js");   /* CORS base, see hz-cors.js */

/* Remove integrity (and crossorigin on stylesheets) from proxied HTML. Scramjet rewrites CSS/JS, so the bytes never
   match the page's original hash and the browser blocks the file (discord.com's Webflow stylesheet showed up bare).
   Scramjet's own scramjet-attr-* attributes are left alone. */
const TAG_RE = /<(?:link|script)\b[^>]*>/gi;
const INTEGRITY_RE = /\s+integrity(?:\s*=\s*("[^"]*"|'[^']*'|[^\s>]+))?(?=[\s>\/])/gi;
const CROSSORIGIN_RE = /\s+crossorigin(?:\s*=\s*("[^"]*"|'[^']*'|[^\s>]+))?(?=[\s>\/])/gi;
const cleanTag = (t) => {
  t = t.replace(INTEGRITY_RE, "");
  return /^<link\b/i.test(t) && /\brel\s*=\s*["']?stylesheet/i.test(t) ? t.replace(CROSSORIGIN_RE, "") : t;
};
async function stripIntegrity(res) {
  try {
    if (!res || res.status !== 200 || !/text\/html/i.test(res.headers.get("content-type") || "")) return res;
    const text = await res.clone().text();
    const h = new Headers(res.headers);
    h.delete("content-length");
    h.delete("content-encoding");
    return new Response(text.replace(TAG_RE, cleanTag), { status: 200, statusText: res.statusText, headers: h });
  } catch (e) { return res; }
}

/* tell open pages that this worker just (re)started, so they can hand it their message port again */
try { new BroadcastChannel("hz-sj").postMessage({ type: "sw-start" }); } catch (e) {}

/* the page sends {type:"hz-ping"} now and then; any event resets the browser's idle timer */
addEventListener("message", () => {});

/* Some browsers (older Chromium, ChromeOS, Firefox/Safari builds) do not expose request.body to service workers,
   so every POST would reach the site with an empty body (Google answers 400 "xsrf"). Read the body into a buffer
   and hand the controller a request whose body is that buffer. */
const BODYLESS = /^(GET|HEAD)$/i;
const shimOf = (target, over) => new Proxy(target, {
  get(t, k) { if (k in over) return over[k]; const v = t[k]; return typeof v === "function" ? v.bind(t) : v; }
});
async function withBody(event) {
  const rq = event.request;
  if (BODYLESS.test(rq.method) || rq.body) return event;
  try {
    const buf = await rq.clone().arrayBuffer();
    if (!buf.byteLength) return event;
    return shimOf(event, { request: shimOf(rq, { body: buf }) });
  } catch (e) { return event; }
}

addEventListener("fetch", (event) => {
  if ($scramjetController.shouldRoute(event)) {
    event.respondWith(withBody(event).then(async (ev) => {
      const pf = HzCors.preflight(ev.request);          /* OPTIONS preflight: answered here */
      if (pf) return pf;
      return HzCors.wrap(await stripIntegrity(await $scramjetController.route(ev)), ev.request);
    }));
  } else HzCors.leak(event.request);   /* not routed: report requests that escape the proxy */
});
