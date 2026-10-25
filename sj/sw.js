/* Scramjet v2 service worker.
   controller.sw.js registers the install/activate handlers and exposes
   $scramjetController.shouldRoute(event) / route(event). */
importScripts("controller/controller.sw.js");
importScripts("hz-cors.js");   /* CORS base, see hz-cors.js */

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
      return HzCors.wrap(await $scramjetController.route(ev), ev.request);
    }));
  } else HzCors.leak(event.request);   /* not routed: report requests that escape the proxy */
});
