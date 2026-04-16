import { createReadStream, existsSync } from "node:fs";
import { promises as fs } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const distDir = path.join(__dirname, "dist");
const indexPath = path.join(distDir, "index.html");
const port = Number(process.env.PORT ?? 4173);
const apiProxyBaseUrl = normalizeBaseUrl(process.env.API_PROXY_BASE_URL ?? process.env.VITE_API_BASE);

const contentTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".gif", "image/gif"],
  [".ico", "image/x-icon"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
  [".ttf", "font/ttf"],
  [".txt", "text/plain; charset=utf-8"],
  [".map", "application/json; charset=utf-8"]
]);

function safePathFromUrl(urlPath) {
  const decoded = decodeURIComponent(urlPath);
  const normalized = path.normalize(decoded).replace(/^([.][.][/\\])+/, "");
  return normalized.startsWith(path.sep) ? normalized.slice(1) : normalized;
}

function setCacheHeaders(res, extension) {
  if (extension === ".html") {
    res.setHeader("Cache-Control", "no-store");
    return;
  }

  if (
    [
      ".js",
      ".css",
      ".svg",
      ".png",
      ".jpg",
      ".jpeg",
      ".webp",
      ".gif",
      ".woff",
      ".woff2",
      ".ttf",
      ".ico"
    ].includes(extension)
  ) {
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    return;
  }

  res.setHeader("Cache-Control", "public, max-age=600");
}

function normalizeBaseUrl(value) {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.replace(/\/+$/, "");
}

function isApiProxyPath(pathname) {
  return (
    pathname === "/api" ||
    pathname.startsWith("/api/") ||
    pathname.startsWith("/hls/") ||
    pathname.startsWith("/uploads/")
  );
}

function copyRequestHeaders(headers) {
  const forwarded = new Headers();
  for (const [key, value] of Object.entries(headers)) {
    if (!value) {
      continue;
    }
    const lower = key.toLowerCase();
    if (["host", "connection", "content-length", "transfer-encoding"].includes(lower)) {
      continue;
    }
    if (Array.isArray(value)) {
      value.forEach((entry) => forwarded.append(key, entry));
      continue;
    }
    forwarded.set(key, value);
  }
  return forwarded;
}

async function proxyApiRequest(req, res, requestUrl) {
  if (!apiProxyBaseUrl) {
    res.statusCode = 502;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ error: "API proxy is not configured on web service." }));
    return;
  }

  const target = `${apiProxyBaseUrl}${requestUrl.pathname}${requestUrl.search}`;
  const headers = copyRequestHeaders(req.headers);
  const method = req.method ?? "GET";
  const upstream = await fetch(target, {
    method,
    headers,
    body: method === "GET" || method === "HEAD" ? undefined : req,
    duplex: method === "GET" || method === "HEAD" ? undefined : "half"
  });

  res.statusCode = upstream.status;
  for (const [key, value] of upstream.headers.entries()) {
    if (key.toLowerCase() === "transfer-encoding") {
      continue;
    }
    res.setHeader(key, value);
  }

  if (!upstream.body) {
    res.end();
    return;
  }

  Readable.fromWeb(upstream.body).pipe(res);
}

const server = createServer(async (req, res) => {
  try {
    const requestUrl = new URL(req.url ?? "/", "http://localhost");
    const pathname = requestUrl.pathname;

    if (isApiProxyPath(pathname)) {
      await proxyApiRequest(req, res, requestUrl);
      return;
    }

    if (pathname === "/health") {
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    let filePath = indexPath;
    if (pathname !== "/") {
      const relative = safePathFromUrl(pathname);
      const candidate = path.join(distDir, relative);
      if (existsSync(candidate)) {
        const stats = await fs.stat(candidate);
        if (stats.isFile()) {
          filePath = candidate;
        }
      }
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = contentTypes.get(ext) ?? "application/octet-stream";
    setCacheHeaders(res, ext);
    res.statusCode = 200;
    res.setHeader("Content-Type", contentType);
    createReadStream(filePath).pipe(res);
  } catch (error) {
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ error: "Failed to serve web app.", detail: String(error) }));
  }
});

server.listen(port, "0.0.0.0", () => {
  console.log(`OpenChannel Web listening on port ${port}`);
});
