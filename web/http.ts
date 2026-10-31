/** Small HTTP helpers for the local server (desktop/server.ts). */
import { createReadStream, createWriteStream, existsSync, rmSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, resolve, sep } from "node:path";

const MAX_JSON = 2 * 1024 ** 2;

export class HttpError extends Error {
  constructor(public code: number, message: string) { super(message); }
}

export const json = (res: ServerResponse, code: number, body: unknown) => {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
};
/** JSON bodies only: a cross-site form or no-cors fetch can't send application/json without a CORS preflight. */
export const body = (req: IncomingMessage) => new Promise<any>((ok, bad) => {
  if (!/^application\/json\b/i.test(req.headers["content-type"] ?? "")) return bad(new HttpError(415, "Cần Content-Type: application/json"));
  let s = "";
  req.on("data", (c) => { s += c; if (s.length > MAX_JSON) { bad(new HttpError(413, "Nội dung quá lớn")); req.destroy(); } });
  req.on("end", () => { try { ok(s ? JSON.parse(s) : {}); } catch { bad(new HttpError(400, "JSON không hợp lệ")); } });
});

/** Stream a raw upload to disk, refusing it (and removing the partial file) once it passes `max` bytes. */
export function saveUpload(req: IncomingMessage, dest: string, max: number) {
  const mb = Math.round(max / 1024 ** 2);
  if (Number(req.headers["content-length"] ?? 0) > max) return Promise.reject(new HttpError(413, `File quá lớn (tối đa ${mb} MB)`));
  return new Promise<void>((ok, bad) => {
    const w = createWriteStream(dest);
    let n = 0, failed = false;
    const fail = (e: Error) => { if (failed) return; failed = true; req.unpipe(w); w.destroy(); rmSync(dest, { force: true }); bad(e); };
    req.on("data", (c: Buffer) => { n += c.length; if (n > max) fail(new HttpError(413, `File quá lớn (tối đa ${mb} MB)`)); });
    req.pipe(w);
    w.on("finish", ok); w.on("error", fail); req.on("error", fail);
  });
}

/**
 * Only our own page may drive the server. A Host other than localhost means DNS rebinding; an Origin other than
 * our own means another site in the browser (CSRF).
 */
const LOCAL = /^(localhost|127\.0\.0\.1|\[::1\]):\d+$/;
export function trusted(req: IncomingMessage) {
  const host = req.headers.host ?? "";
  if (!LOCAL.test(host)) return false;
  const origin = req.headers.origin;
  return !origin || origin === `http://${host}`;
}

export const MIME: Record<string, string> = { ".mp4": "video/mp4", ".mp3": "audio/mpeg", ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg", ".webp": "image/webp", ".txt": "text/plain; charset=utf-8", ".html": "text/html; charset=utf-8", ".js": "text/javascript",
  ".css": "text/css", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".ico": "image/x-icon" };

/** Serve `relPath` (resolved against `base`, and only if it lands inside `within`) with HTTP Range so <video>/<audio> can seek. */
export function serveFile(req: IncomingMessage, res: ServerResponse, relPath: string, base: string, within = base) {
  const p = resolve(base, decodeURIComponent(relPath));
  if (!(p + sep).startsWith(within + sep) || !existsSync(p) || !statSync(p).isFile()) { res.writeHead(404); res.end(); return; }
  const size = statSync(p).size, type = MIME[extname(p).toLowerCase()] ?? "application/octet-stream";
  const range = req.headers.range?.match(/bytes=(\d*)-(\d*)/);
  if (range) {
    const start = range[1] ? Number(range[1]) : 0, end = Math.min(size - 1, range[2] ? Number(range[2]) : size - 1);
    if (start > end) { res.writeHead(416, { "Content-Range": `bytes */${size}` }); res.end(); return; }
    res.writeHead(206, { "Content-Type": type, "Content-Range": `bytes ${start}-${end}/${size}`, "Accept-Ranges": "bytes", "Content-Length": end - start + 1 });
    createReadStream(p, { start, end }).on("error", () => res.destroy()).pipe(res);
  } else {
    res.writeHead(200, { "Content-Type": type, "Content-Length": size, "Accept-Ranges": "bytes" });
    createReadStream(p).on("error", () => res.destroy()).pipe(res);
  }
}
