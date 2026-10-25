import http from "node:http";
import { server as wisp } from "@mercuryworkshop/wisp-js/server";
const srv = http.createServer((req, res) => { res.writeHead(200, { "content-type": "text/plain" }); res.end("wisp server ok"); });
srv.on("upgrade", (req, socket, head) => wisp.routeRequest(req, socket, head));
srv.listen(process.env.PORT || 8080, "0.0.0.0", () => console.log("wisp listening on", process.env.PORT || 8080));
