/**
 * Roads and areas on aerial footage (scripts/drone-map.py): the map editor's API, served by desktop/server.ts. Each step runs in the background and writes
 * <root>/output/drone/<name>/status.json, which the editor polls.
 */
import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { execFileSync, spawn } from "node:child_process";
import { homedir } from "node:os";
import { basename, extname, join, relative, resolve } from "node:path";
import { HttpError, body, json, saveUpload } from "./http";

export type MapConfig = {
  /** runs live in <root>/output/drone, and /files/ URLs are relative to root */
  root: string;
  /** where the render and the editor's player read clips and documents from (public) */
  publicDir: string;
  scripts: string;
  python: string;
  /** extra environment for drone-map.py, read on every run (the AI provider and its key can change) */
  env?: () => NodeJS.ProcessEnv;
};

export function mapApi(cfg: MapConfig) {
  const DRONE = join(cfg.root, "output", "drone");
  const runs = new Map<string, ReturnType<typeof spawn>>();

  function droneRun(name: string, args: string[]) {
    if (runs.get(name)?.exitCode === null) throw new HttpError(409, "Bước trước vẫn đang chạy");
    const dir = join(DRONE, name);
    mkdirSync(dir, { recursive: true });
    const log = createWriteStream(join(dir, "log.txt"), { flags: "a" });
    const p = spawn(cfg.python, [join(cfg.scripts, "drone-map.py"), ...args, "--name", name], { cwd: cfg.root, env: { ...process.env, ...cfg.env?.() } });
    p.stdout.pipe(log); p.stderr.pipe(log);
    const fail = (msg: string) => writeFileSync(join(dir, "status.json"), JSON.stringify({ step: "error", msg }));
    p.on("error", (e) => fail(`Không chạy được Python: ${e.message}`));
    p.on("close", (code) => {
      if (code && existsSync(join(dir, "status.json"))) {
        const st = JSON.parse(readFileSync(join(dir, "status.json"), "utf8"));
        if (st.step !== "error") fail(readFileSync(join(dir, "log.txt"), "utf8").slice(-600));
      }
    });
    runs.set(name, p);
  }
  const mapState = (name: string) => {
    const read = (f: string) => { const p = join(DRONE, name, f); try { return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null; } catch { return null; } };
    const meta = read("meta.json");
    // runs made before the clip's length was kept: find it once
    if (meta && !meta.clipDur && meta.clip && existsSync(meta.clip)) {
      try {
        meta.clipDur = Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", meta.clip], { encoding: "utf8" }).trim()) || undefined;
        if (meta.clipDur) writeFileSync(join(DRONE, name, "meta.json"), JSON.stringify(meta));
      } catch { /* the clip is gone */ }
    }
    return { name, status: read("status.json"), meta, fit: read("fit.json"), doc: read("map.json"), plan: read("plan.json"),
      request: read("request.json"), color: read("color.json"), running: runs.get(name)?.exitCode === null };
  };
  /** A strip of thumbnails over the whole clip for the range picker, and whether the file carries DJI flight data. */
  async function mapThumbs(clip: string) {
    const probe = (args: string[]) => execFileSync("ffprobe", ["-v", "error", ...args, clip], { encoding: "utf8" });
    const dur = Number(probe(["-show_entries", "format=duration", "-of", "csv=p=0"]).trim()) || 0;
    const dji = /codec_tag_string=djmd/.test(probe(["-show_entries", "stream=codec_tag_string", "-of", "compact"]));
    const key = `${basename(clip).replace(/[^\w-]+/g, "-").slice(0, 40)}-${statSync(clip).size}`;
    const dir = join(DRONE, "_thumbs", key);
    mkdirSync(dir, { recursive: true });
    const N = 12;
    await Promise.all(Array.from({ length: N }, (_, i) => new Promise<void>((ok) => {
      const out = join(dir, `t${i}.jpg`);
      if (existsSync(out)) return ok();
      const p = spawn("ffmpeg", ["-v", "error", "-y", "-ss", String(((i + 0.5) * dur) / N), "-i", clip, "-frames:v", "1", "-vf", "scale=-2:180", "-q:v", "4", out]);
      p.on("close", () => ok()); p.on("error", () => ok());
    })));
    return { dur, dji, thumbs: Array.from({ length: N }, (_, i) => `/files/${relative(cfg.root, join(dir, `t${i}.jpg`)).split("\\").join("/")}`) };
  }
  const mapClip = (b: Record<string, unknown>) => {
    const clip = resolve(cfg.root, String(b.clip ?? "").replace(/^~(?=[/\\])/, homedir()));
    if (!existsSync(clip) || !statSync(clip).isFile()) throw new HttpError(400, "Không thấy file video");
    return clip;
  };
  const lutPath = (v: unknown) => {
    if (!v) return null;
    const p = resolve(cfg.root, String(v));
    if (!p.endsWith(".cube") || !existsSync(p)) throw new HttpError(400, "LUT phải là file .cube");
    return p;
  };

  /** the map editor's routes; false when the request is not one of them */
  return async function handle(req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean> {
    let m0: RegExpMatchArray | null;
    if (path === "/api/map/thumbs" && req.method === "POST") { json(res, 200, await mapThumbs(mapClip(await body(req)))); return true; }
    if (path === "/api/map" && req.method === "GET") {
      const names = existsSync(DRONE) ? readdirSync(DRONE).filter((n) => existsSync(join(DRONE, n, "request.json"))).sort().reverse().slice(0, 12) : [];
      json(res, 200, names.map((n) => ({ name: n, request: JSON.parse(readFileSync(join(DRONE, n, "request.json"), "utf8")) })));
      return true;
    }
    if (path === "/api/map" && req.method === "POST") {
      const b = await body(req), clip = mapClip(b);
      const name = `${new Date().toISOString().slice(5, 19).replace(/[-:T]/g, "")}-${basename(clip).replace(/\.[^.]+$/, "").replace(/[^\w-]+/g, "-").slice(0, 30)}`;
      const center = await resolveCenter(b.center);
      const c = (b.color ?? {}) as Record<string, unknown>;
      const color = { delog: ["auto", "none", "dlogm", "dlog", "hlg"].includes(String(c.delog)) ? c.delog : "auto", lut: lutPath(c.lut),
        strength: Math.max(0, Math.min(1, Number(c.strength ?? 1))), look: ["none", "warm", "natural", "cinematic"].includes(String(c.look)) ? c.look : "none" };
      mkdirSync(join(DRONE, name), { recursive: true });
      writeFileSync(join(DRONE, name, "request.json"), JSON.stringify({ clip, request: String(b.request ?? "").slice(0, 2000), aspect: ["9:16", "1:1", "4:5"].includes(String(b.aspect)) ? b.aspect : "16:9",
        look: ["gold", "mint", "clean"].includes(String(b.look)) ? b.look : undefined, color }));
      droneRun(name, ["start", clip, "--start", String(Math.max(0, Number(b.start) || 0)), "--dur", String(Math.max(2, Math.min(30, Number(b.dur) || 8))),
        ...(center ? ["--center", center] : [])]);
      json(res, 200, { name });
      return true;
    }
    if ((m0 = path.match(/^\/api\/map\/([\w-]+)$/))) { json(res, 200, mapState(m0[1])); return true; }
    // an image for a map doc (a building facade): kept next to its clip in public, so the render can read it
    if ((m0 = path.match(/^\/api\/map\/([\w-]+)\/asset$/)) && req.method === "POST") {
      const name = m0[1], ext = extname(String(req.headers["x-filename"] ?? "")).toLowerCase();
      if (!existsSync(join(DRONE, name, "request.json"))) { json(res, 404, { error: "Không có phiên này" }); return true; }
      if (![".jpg", ".jpeg", ".png", ".webp"].includes(ext)) { json(res, 400, { error: "Chỉ nhận ảnh JPG, PNG hoặc WebP" }); return true; }
      const dir = join(cfg.publicDir, `map-${name}`);
      mkdirSync(dir, { recursive: true });
      const file = `asset-${Date.now()}${ext}`;
      await saveUpload(req, join(dir, file), 40 * 1024 * 1024);
      json(res, 200, { path: `map-${name}/${file}` });
      return true;
    }
    if ((m0 = path.match(/^\/api\/map\/([\w-]+)\/(place|points|draft|doc|color|recut|occluders|refit|segment|render)$/)) && (req.method === "POST" || req.method === "PUT")) {
      const b = await body(req), [, name, step] = m0, dir = join(DRONE, name);
      if (!existsSync(join(dir, "request.json"))) { json(res, 404, { error: "Không có phiên này" }); return true; }
      if (step === "place") {
        const center = await resolveCenter(b.center);
        if (!center) { json(res, 400, { error: "Không đọc được toạ độ: dán dạng 13.76, 109.22 hoặc link Google Maps (cả link rút gọn maps.app.goo.gl)" }); return true; }
        droneRun(name, ["place-go", "--center", center]);
      } else if (step === "points") {
        const pairs = Array.isArray(b.pairs) ? b.pairs.filter((p: unknown) => Array.isArray(p) && p.length === 4 && p.every((v) => Number.isFinite(v))) : [];
        if (pairs.length < 3) { json(res, 400, { error: "Cần ít nhất 3 điểm" }); return true; }
        droneRun(name, ["points", "--pairs", JSON.stringify(pairs), ...(b.keep ? ["--keep"] : [])]);
      } else if (step === "draft") {
        if (typeof b.request === "string") {
          const r = JSON.parse(readFileSync(join(dir, "request.json"), "utf8"));
          writeFileSync(join(dir, "request.json"), JSON.stringify({ ...r, request: b.request.slice(0, 2000) }));
        }
        droneRun(name, ["draft", ...(b.plain ? ["--plain"] : [])]);
      } else if (step === "doc") {
        // the editor's own save: layers, styles, aspect, look, title
        const doc = b.doc as Record<string, unknown> | undefined;
        if (!doc || !Array.isArray(doc.layers) || !Array.isArray(doc.H)) { json(res, 400, { error: "Tài liệu không hợp lệ" }); return true; }
        writeFileSync(join(dir, "map.json"), JSON.stringify(doc));
      } else if (step === "color") {
        const args = ["--delog", ["auto", "none", "dlogm", "dlog", "hlg"].includes(String(b.delog)) ? String(b.delog) : "auto",
          "--strength", String(Math.max(0, Math.min(1, Number(b.strength ?? 1)))), "--look", ["none", "warm", "natural", "cinematic"].includes(String(b.look)) ? String(b.look) : "none"];
        const lut = lutPath(b.lut);
        if (lut) args.push("--lut", lut);
        if (b.still) args.push("--still");
        const r = JSON.parse(readFileSync(join(dir, "request.json"), "utf8"));
        if (!b.still) writeFileSync(join(dir, "request.json"), JSON.stringify({ ...r, color: { delog: args[1], strength: Number(args[3]), look: args[5], lut } }));
        droneRun(name, ["color", "--args", JSON.stringify(args)]);
      } else if (step === "segment") {
        // the building clicked on, followed through the clip by SAM 2
        const pts = Array.isArray(b.points) ? b.points.filter((p: unknown) => Array.isArray(p) && p.length >= 2 && p.slice(0, 2).every((v) => Number.isFinite(v) && v >= 0 && v <= 1)).slice(0, 12) : [];
        if (!pts.length) { json(res, 400, { error: "Bấm vào toà nhà cần tách" }); return true; }
        droneRun(name, ["segment", "--frame", String(Math.max(0, Math.floor(Number(b.frame) || 0))), "--points", JSON.stringify(pts), ...(b.highlight === false ? ["--no-highlight"] : []),
          ...(typeof b.label === "string" && b.label.trim() ? ["--label", b.label.trim().slice(0, 60)] : [])]);
      } else if (step === "refit") {
        // match the map again: back to the points screen (or out of it, cancelled); the doc stays as it is
        const st = b.cancel ? { step: "ready", time: Date.now() / 1000, msg: "Giữ bản đồ cũ" } : { step: "need-points", time: Date.now() / 1000, msg: "Chọn lại các cặp điểm để khớp bản đồ" };
        writeFileSync(join(dir, "status.json"), JSON.stringify(st));
      } else if (step === "occluders") {
        droneRun(name, ["occluders"]);
      } else if (step === "recut") {
        // a new stretch of the clip: cut and tracked again, the layers carried over
        const start = Math.max(0, Number(b.start) || 0), dur = Math.max(1, Math.min(30, Number(b.dur) || 8));
        droneRun(name, ["recut", "--start", String(start), "--dur", String(dur)]);
      } else droneRun(name, ["render"]);
      json(res, 200, { ok: true });
      return true;
    }
    return false;
  };
}

/** "13.76, 109.22" or a Google Maps link (…/@13.76,109.22,… or ?q=13.76,109.22) → "lat,lon" */
function parseCenter(s: unknown) {
  const t = decodeURIComponent(String(s ?? ""));
  // a place in a Google Maps link (!3d lat !4d lon) is the pin itself, "@lat,lon" only the middle of the view
  const pin = t.match(/!3d(-?\d{1,2}\.\d+)!4d(-?\d{1,3}\.\d+)/);
  if (pin) return `${pin[1]},${pin[2]}`;
  const m = t.match(/(-?\d{1,2}\.\d+)\s*,\s*\+?(-?\d{1,3}\.\d+)/);
  return m ? `${m[1]},${m[2]}` : null;
}
/** like parseCenter, and a short Google Maps link (maps.app.goo.gl, goo.gl/maps) is opened to read the full one */
async function resolveCenter(s: unknown) {
  const direct = parseCenter(s);
  if (direct) return direct;
  let u = String(s ?? "").trim().match(/https?:\/\/(?:maps\.app\.goo\.gl|goo\.gl\/maps)\/\S+/)?.[0];
  for (let hop = 0; u && hop < 6; hop++) {
    try {
      const r = await fetch(u, { redirect: "manual", signal: AbortSignal.timeout(6000) });
      const next = r.headers.get("location");
      const found = parseCenter(next ?? "") ?? (next ? null : parseCenter((await r.text()).slice(0, 400000)));
      if (found) return found;
      u = next ? new URL(next, u).toString() : undefined;
    } catch { return null; }
  }
  return null;
}
