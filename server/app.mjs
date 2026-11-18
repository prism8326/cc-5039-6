import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createLicenseService } from "./license-service.mjs";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const PORT = Number(process.env.PORT ?? 4173);
const HOST = process.env.HOST ?? "127.0.0.1";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".woff2": "font/woff2",
  ".mp4": "video/mp4",
  ".m4s": "video/iso.segment",
  ".png": "image/png",
  ".svg": "image/svg+xml"
};

const lesson = JSON.parse(await readFile(join(ROOT, "config/lesson.json"), "utf8"));
const keys = JSON.parse(await readFile(join(ROOT, "config/test-keys.json"), "utf8"));
const licenseService = createLicenseService({ lesson, keys });

const MEDIA_ROOT = resolve(ROOT, "media/packaged");
const UI_ROOT = resolve(ROOT, "ui");
const SHARED_ROOT = resolve(ROOT, "shared");

function sendJson(res, status, body, headers = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    ...headers
  });
  res.end(payload);
}

function insideRoot(root, target) {
  return target === root || target.startsWith(root + sep);
}

async function serveFile(res, root, relativePath, { immutable = false } = {}) {
  const target = normalize(join(root, relativePath));
  if (!insideRoot(root, target)) {
    sendJson(res, 403, { error: "forbidden" });
    return;
  }
  let info;
  try {
    info = await stat(target);
  } catch {
    sendJson(res, 404, { error: "not-found" });
    return;
  }
  if (!info.isFile()) {
    sendJson(res, 404, { error: "not-found" });
    return;
  }
  const type = MIME[extname(target)] ?? "application/octet-stream";
  res.writeHead(200, {
    "content-type": type,
    "content-length": info.size,
    "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
    "accept-ranges": "none"
  });
  createReadStream(target).pipe(res);
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolveBody, rejectBody) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        rejectBody(new Error("payload-too-large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolveBody(Buffer.concat(chunks).toString("utf8")));
    req.on("error", rejectBody);
  });
}

function applyCors(req, res) {
  const origin = req.headers.origin;
  if (origin && (origin === `http://${HOST}:${PORT}` || origin === `http://localhost:${PORT}`)) {
    res.setHeader("access-control-allow-origin", origin);
    res.setHeader("vary", "origin");
  }
  res.setHeader("access-control-allow-headers", "content-type");
  res.setHeader("access-control-allow-methods", "POST, GET, OPTIONS");
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? `${HOST}:${PORT}`}`);
  const pathname = decodeURIComponent(url.pathname);
  applyCors(req, res);

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  try {
    if (pathname === "/favicon.ico") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (pathname === "/api/course" && req.method === "GET") {
      sendJson(res, 200, {
        schema: "edu-drm-lab/course-view@1",
        course: lesson.course,
        license: {
          keySystem: lesson.license.keySystem,
          keySystemLabel: lesson.license.keySystemLabel,
          robustness: lesson.license.robustness,
          endpointPath: lesson.license.endpointPath
        },
        mediaAsset: lesson.mediaAsset,
        credentials: lesson.credentials,
        scenarios: lesson.scenarios,
        diagnostics: lesson.diagnostics,
        protection: lesson.protection
      });
      return;
    }

    if (pathname === "/api/license" && req.method === "POST") {
      let body;
      try {
        body = JSON.parse(await readBody(req));
      } catch {
        sendJson(res, 400, { error: "malformed-request" }, { "cache-control": "no-store" });
        return;
      }
      const result = licenseService.handle(body);
      sendJson(res, result.status, result.body, {
        "cache-control": "no-store",
        ...(result.headers ?? {})
      });
      return;
    }

    if (pathname === "/api/license" && req.method !== "POST") {
      sendJson(res, 405, { error: "method-not-allowed" });
      return;
    }

    if (pathname.startsWith("/media/packaged/")) {
      const relativePath = pathname.slice("/media/packaged/".length);
      await serveFile(res, MEDIA_ROOT, relativePath, { immutable: true });
      return;
    }

    if (pathname.startsWith("/shared/")) {
      await serveFile(res, SHARED_ROOT, pathname.slice("/shared/".length));
      return;
    }

    const uiPath = pathname === "/" ? "index.html" : pathname.slice(1);
    await serveFile(res, UI_ROOT, uiPath);
  } catch (error) {
    if (error?.message === "payload-too-large") {
      sendJson(res, 413, { error: "payload-too-large" });
      return;
    }
    process.stderr.write(`[server] ${error?.stack ?? error}\n`);
    sendJson(res, 500, { error: "internal-error" });
  }
});

server.listen(PORT, HOST, () => {
  process.stdout.write(
    `[server] 授权教学本地服务已启动：http://${HOST}:${PORT}/ （图形入口 /ui/index.html）\n`
  );
});
