const http = require("node:http");
const fs = require("node:fs");
const { join, resolve, extname } = require("node:path");

const PORT = Number(process.env.PORT || 4173);
const HOST = process.env.HOST || "0.0.0.0";
const BACKEND_API = process.env.BACKEND_API || "http://127.0.0.1:4173";

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".mp4": "video/mp4",
  ".wav": "audio/wav",
  ".vtt": "text/vtt; charset=utf-8",
  ".srt": "text/plain; charset=utf-8"
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const pathname = url.pathname;

  // Proxy /api/* and /media/* to backend API if configured
  if ((pathname.startsWith("/api/") || pathname.startsWith("/media/")) && BACKEND_API && BACKEND_API !== `http://127.0.0.1:${PORT}`) {
    const targetUrl = new URL(pathname + url.search, BACKEND_API);
    const proxyReq = http.request(targetUrl, {
      method: req.method,
      headers: { ...req.headers, host: targetUrl.host }
    }, (proxyRes) => {
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res);
    });
    proxyReq.on("error", () => {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Backend generation harness not reachable." }));
    });
    req.pipe(proxyReq);
    return;
  }

  // Serve static UI assets
  const filename = pathname === "/" ? "index.html" : pathname.slice(1);
  const filePath = resolve(__dirname, filename);
  if (filePath.startsWith(__dirname) && fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    const ext = extname(filePath).toLowerCase();
    res.writeHead(200, {
      "Content-Type": MIME_TYPES[ext] || "application/octet-stream",
      "Cache-Control": "no-store"
    });
    fs.createReadStream(filePath).pipe(res);
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not found");
});

server.listen(PORT, HOST, () => {
  console.log(`Lost in Translation Studio UI running at http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT}`);
});
