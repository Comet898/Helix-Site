importScripts("scramjet.all.js");
const { ScramjetServiceWorker } = $scramjetLoadWorker();
const scramjet = new ScramjetServiceWorker();
let bc; try { bc = new BroadcastChannel("hzlog"); } catch (e) {}
const say = (lvl, msg) => { try { bc && bc.postMessage({ lvl, src: "net", msg }); } catch (e) {} };
const V = "141", FV = "141.0.7390.55";
const OS = {
  win: { ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/" + V + ".0.0.0 Safari/537.36", plat: "Windows", nav: "Win32", pv: "15.0.0", arch: "x86" },
  mac: { ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/" + V + ".0.0.0 Safari/537.36", plat: "macOS", nav: "MacIntel", pv: "14.6.1", arch: "arm" },
  linux: { ua: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/" + V + ".0.0.0 Safari/537.36", plat: "Linux", nav: "Linux x86_64", pv: "6.8.0", arch: "x86" }
};
const P = OS[new URL(self.location).searchParams.get("ua") || "win"] || null;   /* ua=off disables spoofing */
const BR = [["Chromium", V], ["Not?A_Brand", "8"], ["Google Chrome", V]];
const CHUA = BR.map(([b, v]) => '"' + b + '";v="' + v + '"').join(", ");
const LANG = (self.navigator && self.navigator.language) || "en-US";
const J = JSON.stringify;
/* injected into every proxied HTML page so JavaScript sees the same identity as the request headers */
const SPOOF = P && ("<script>(function(){try{var U=" + J(P.ua) + ",B=" + J(BR.map(([b, v]) => ({ brand: b, version: v }))) + ",FB=" + J(BR.map(([b, v]) => ({ brand: b, version: v === "8" ? "8.0.0.0" : FV }))) +
  ";var N=Navigator.prototype,D=function(o,k,v){Object.defineProperty(o,k,{get:function(){return v},configurable:true})};D(N,'userAgent',U);D(N,'appVersion',U.slice(8));D(N,'platform'," + J(P.nav) + ");D(N,'vendor','Google Inc.');" +
  "var H={brands:B,mobile:false,platform:" + J(P.plat) + ",getHighEntropyValues:function(){return Promise.resolve({brands:B,mobile:false,platform:" + J(P.plat) + ",platformVersion:" + J(P.pv) + ",architecture:" + J(P.arch) + ",bitness:'64',model:'',uaFullVersion:" + J(FV) + ",fullVersionList:FB,wow64:false})},toJSON:function(){return{brands:B,mobile:false,platform:" + J(P.plat) + "}}};D(N,'userAgentData',H);" +
  "if(!window.chrome)window.chrome={app:{isInstalled:false},runtime:{}};}catch(e){}})()<\/script>");
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", e => e.waitUntil(self.clients.claim()));
/* request headers that look like Chrome 141 */
scramjet.addEventListener("request", e => {
  const h = e.requestHeaders; if (!h) return;
  const isH = typeof h.set === "function" && typeof h.keys === "function";
  const keys = () => isH ? [...h.keys()] : Object.keys(h);
  const set = (k, v) => { if (isH) h.set(k, v); else h[k] = v; };
  if (P) {
    for (const k of keys()) if (/^(user-agent|sec-ch-ua.*)$/i.test(k)) { if (isH) h.delete(k); else delete h[k]; }
    set("User-Agent", P.ua); set("sec-ch-ua", CHUA); set("sec-ch-ua-mobile", "?0"); set("sec-ch-ua-platform", '"' + P.plat + '"');
  }
  const has = n => keys().some(k => k.toLowerCase() === n);
  if (!has("accept-language")) set("Accept-Language", LANG + "," + LANG.split("-")[0] + ";q=0.9");
  if (/^(document|iframe)$/.test(e.destination) && !has("upgrade-insecure-requests")) set("Upgrade-Insecure-Requests", "1");
});
async function handle(event) {
  await scramjet.loadConfig();
  if (!scramjet.route(event)) return fetch(event.request);
  const t0 = Date.now(), req = event.request, i = req.url.indexOf("/service/");
  let real = req.url; try { real = decodeURIComponent(req.url.slice(i + 9)); } catch (e) {}
  let r;
  try { r = await scramjet.fetch(event); }
  catch (err) { say("error", "FAILED " + (req.destination || "fetch") + " " + real + " :: " + (err && err.message || err)); throw err; }
  say(r.status >= 400 ? "warn" : "net", r.status + " " + (req.destination || "fetch") + " " + real.slice(0, 300) + " (" + (Date.now() - t0) + "ms)");
  if (r.status >= 400 && /json|text/i.test(r.headers.get("content-type") || "")) r.clone().text().then(b => say("warn", "   response body: " + b.replace(/\s+/g, " ").slice(0, 400))).catch(() => {});
  if (SPOOF && /^(document|iframe)$/.test(req.destination) && /html/i.test(r.headers.get("content-type") || "")) {
    try {
      const txt = await r.clone().text();
      const out = /<head[^>]*>/i.test(txt) ? txt.replace(/<head[^>]*>/i, m => m + SPOOF) : txt.replace(/<html[^>]*>/i, m => m + SPOOF);
      if (out !== txt) { const hd = new Headers(r.headers); hd.delete("content-length"); return new Response(out, { status: r.status, statusText: r.statusText, headers: hd }); }
    } catch (e) { say("warn", "identity injection skipped: " + e.message); }
  }
  return r;
}
self.addEventListener("fetch", e => e.respondWith(handle(e)));
