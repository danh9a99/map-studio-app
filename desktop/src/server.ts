/**
 * The desktop map app's local server: the map editor's API (web/mapapi.ts) on the user's data folder, the built
 * editor page, the first-run setup and the settings. Started by main.ts inside Electron, or by dev.ts on its own.
 *
 * <data>/output/drone   the runs
 * <data>/site           the render bundle, copied from the app; its public/ holds each run's clip and document
 * <data>/runtime        Python, the SAM 2 add-on, the render's browser (setup.ts)
 * <data>/settings.json  the AI provider, its model, the keys (encrypted by the OS when Electron can)
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { createRequire } from "node:module";
import { delimiter, dirname, join, relative } from "node:path";
import { HttpError, body, json, saveUpload, serveFile, trusted } from "../../web/http";
import { mapApi } from "../../web/mapapi";
import { createSetup } from "./setup";

export type ServerOptions = {
  /** the app folder: dist/, ui/, site/, scripts/, python/, bin/ (dev: desktop/app) */
  app: string;
  data: string;
  version: string;
  /** a Node to run dist/render.cjs with (Electron's own binary, with ELECTRON_RUN_AS_NODE) */
  node: string;
  encrypt: (s: string) => string;
  decrypt: (s: string) => string;
  /** dev: serve the editor from Vite on web instead of the built ui/, on a fixed port */
  vite?: boolean;
  port?: number;
};

type Provider = "anthropic" | "gemini";
type Settings = { ai: "none" | Provider; model: string; keys: Partial<Record<Provider, string>> };
const MODELS: Record<Provider, string[]> = {
  anthropic: ["claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5"],
  gemini: ["gemini-flash-latest", "gemini-pro-latest"],
};
const KEY_ENV: Record<Provider, string> = { anthropic: "ANTHROPIC_API_KEY", gemini: "GEMINI_API_KEY" };
const MAX_VIDEO = 8 * 1024 ** 3;

export async function startServer(o: ServerOptions) {
  const site = join(o.data, "site"), pub = join(site, "public"), ui = join(o.app, "ui");
  mkdirSync(join(o.data, "output", "_uploads"), { recursive: true });
  // the render bundle comes with the app; the clips and documents beside it (public/) are the user's and stay
  const bundled = join(o.app, "site");
  const stamp = existsSync(bundled) ? `${o.version} ${statSync(join(bundled, "index.html")).mtimeMs}` : "";
  if (stamp && (!existsSync(join(site, ".version")) || readFileSync(join(site, ".version"), "utf8") !== stamp)) {
    mkdirSync(site, { recursive: true });
    for (const f of readdirSync(site)) if (f !== "public") rmSync(join(site, f), { recursive: true, force: true });
    cpSync(bundled, site, { recursive: true, filter: (src) => relative(bundled, src).split(/[\\/]/)[0] !== "public" });
    writeFileSync(join(site, ".version"), stamp);
  }
  mkdirSync(pub, { recursive: true });

  // ffmpeg / ffprobe for the scripts and the thumbnails: full builds from npm (Remotion's own lacks filters we use)
  const need = createRequire(join(o.app, "package.json"));
  const bins = [dirname(need("ffmpeg-static") as string), dirname((need("ffprobe-static") as { path: string }).path)];
  process.env.PATH = [...bins, process.env.PATH ?? ""].join(delimiter);

  const rt = createSetup({ app: o.app, data: o.data, node: o.node });
  const settingsFile = join(o.data, "settings.json");
  const readSettings = (): Settings => {
    try { return { ai: "none", model: "", keys: {}, ...JSON.parse(readFileSync(settingsFile, "utf8")) }; } catch { return { ai: "none", model: "", keys: {} }; }
  };
  const writeSettings = (s: Settings) => writeFileSync(settingsFile, JSON.stringify(s, null, 1));
  const keyOf = (s: Settings, p: Provider) => { try { return s.keys[p] ? o.decrypt(s.keys[p]!) : null; } catch { return null; } };

  const env = (): NodeJS.ProcessEnv => {
    const s = readSettings(), key = s.ai !== "none" ? keyOf(s, s.ai) : null;
    return {
      MAP_ROOT: o.data, MAP_PUBLIC: pub, MAP_SITE: site, MAP_RENDER: JSON.stringify([o.node, join(o.app, "dist", "render.cjs")]), ELECTRON_RUN_AS_NODE: "1",
      MAP_SAM_PYTHON: rt.samPython, MAP_SAM_MODELS: rt.samModels,
      MAP_AI: key ? s.ai : "none", MAP_AI_MODEL: s.model, ...(key && s.ai !== "none" ? { [KEY_ENV[s.ai]]: key } : {}),
      PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8",
    };
  };
  const map = mapApi({ root: o.data, publicDir: pub, scripts: join(o.app, "scripts"), python: rt.python, env });

  const state = () => {
    const s = readSettings();
    return { version: o.version, setup: rt.setup, sam: rt.sam,
      settings: { ai: s.ai, model: s.model, keys: { anthropic: !!keyOf(s, "anthropic"), gemini: !!keyOf(s, "gemini") } } };
  };

  const vite = o.vite ? await (await import("vite")).createServer({
    root: join(o.app, "..", "..", "web"), publicDir: false, appType: "custom",
    server: { middlewareMode: true, fs: { allow: [join(o.app, "..", "..")] } }, esbuild: { jsx: "automatic" },
  }) : null;

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    if (path === "/api/app") return json(res, 200, state());
    if (path === "/api/setup/retry" && req.method === "POST") { rt.first(); return json(res, 200, { ok: true }); }
    if (path === "/api/sam/install" && req.method === "POST") { rt.installSam(); return json(res, 200, { ok: true }); }
    if (path === "/api/settings" && req.method === "PUT") {
      const b = await body(req), s = readSettings();
      if (b.forget === "anthropic" || b.forget === "gemini") { delete s.keys[b.forget as Provider]; if (s.ai === b.forget) s.ai = "none"; writeSettings(s); return json(res, 200, { ok: true }); }
      if (!["none", "anthropic", "gemini"].includes(b.ai)) throw new HttpError(400, "Nhà cung cấp không hợp lệ");
      s.ai = b.ai;
      if (b.ai !== "none") {
        const p = b.ai as Provider;
        s.model = MODELS[p].includes(b.model) ? b.model : MODELS[p][1] ?? MODELS[p][0];
        if (typeof b.key === "string" && b.key.trim()) {
          if (b.key.trim().length < 20 || /\s/.test(b.key.trim())) throw new HttpError(400, "API key không đúng dạng");
          s.keys[p] = o.encrypt(b.key.trim());
        }
        if (!keyOf(s, p)) throw new HttpError(400, "Chưa có API key");
      }
      writeSettings(s);
      return json(res, 200, { ok: true });
    }
    // the clip to draw on: copied into the data folder
    if (path === "/api/upload" && req.method === "POST") {
      const name = decodeURIComponent(String(req.headers["x-filename"] ?? "video.mp4")).replace(/[^\w.\-]+/g, "_").slice(-80);
      const dest = join(o.data, "output", "_uploads", `${Date.now()}-${name}`);
      await saveUpload(req, dest, MAX_VIDEO);
      return json(res, 200, { path: relative(o.data, dest).split("\\").join("/") });
    }
    if (await map(req, res, path)) return;
    if (path.startsWith("/files/")) return serveFile(req, res, path.slice("/files/".length), o.data, join(o.data, "output"));
    // a run's clip, document, outlines and facade images (staticFile in the editor's player)
    if (/^\/map-[\w-]+\//.test(path)) return serveFile(req, res, path.slice(1), pub);
    if (vite) {
      if (path === "/" || path === "/index.html") {
        const html = await vite.transformIndexHtml("/map.html", readFileSync(join(o.app, "..", "..", "web", "map.html"), "utf8"));
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        return res.end(html);
      }
      return vite.middlewares(req, res);
    }
    return serveFile(req, res, path === "/" ? "map.html" : path.slice(1), ui);
  }

  const server = createServer(async (req, res) => {
    if (!trusted(req)) { res.writeHead(403); res.end(); return; }
    try { await handle(req, res); } catch (e) {
      console.error(`[${req.method} ${req.url}]`, e);
      if (res.headersSent) res.destroy();
      else json(res, e instanceof HttpError ? e.code : 500, { error: (e as Error).message });
    }
  });
  await new Promise<void>((ok) => server.listen(o.port ?? 0, "127.0.0.1", ok));
  rt.first();
  return { port: (server.address() as AddressInfo).port, close: () => server.close() };
}
