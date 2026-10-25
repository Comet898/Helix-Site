# CORS base (starting point)

Files: `sj/hz-cors.js` (all the logic and the settings), used by `sj/sw.js` (Scramjet) and `sw.js` (lite engine).

## What is in place
* `HzCors.wrap / apply`: every response the workers hand back gets rebuilt CORS headers (real site's `access-control-*` dropped, Origin echoed, credentials allowed, `cross-origin-resource-policy: cross-origin`).
* `HzCors.preflight`: an `OPTIONS` preflight that reaches a worker is answered with a 204 instead of being sent to the site.
* `HzCors.leak` (Scramjet worker): logs requests from a proxied page that are NOT routed through Scramjet. These go straight to the real site with this page's origin, so the real site's CORS rules apply. Look for `ESCAPED THE PROXY` lines (source `cors`) in the Logs panel.
* All settings are in `CFG` at the top of `sj/hz-cors.js`. `CFG.enabled = false` switches the layer off.

## Tested locally (headless Chromium, local Wisp, fake sites)
* A proxied page doing `fetch` with a custom header + credentials, a plain `fetch`, and a credentialed XHR to another origin all succeed through Scramjet, and the target site receives the real `Origin` and `Referer`.
* `hz-cors.js` unit tests: preflight answer, header replacement, body/status preserved, null origin, disabled mode, leak filter.

## Not done / next steps
* No real escaping request has been observed in a browser yet. A request that bypasses Scramjet (a worker, `importScripts`, `EventSource`, a URL built after rewriting) gets a CORS error from the real site. Turn `HzCors.leak` into a re-route: build the proxied address for the URL and fetch that instead.
* The service worker only sees requests from pages under `/sj/` (Scramjet) or `/service/` (lite engine); the shell page itself is not controlled by the Scramjet worker.
* Check the Logs panel on a site that shows the error and look for the `ESCAPED THE PROXY` address.
