/**
 * What the app fetches on this machine instead of shipping it: Python with the map scripts' libraries and the render's
 * headless browser on the first run, and the SAM 2 add-on (PyTorch, the model) when the user asks for it.
 * Python comes from uv (bundled in <app>/bin), everything lands in <data>/runtime.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export type Stage = { ready: boolean; busy: boolean; pct: number; msg: string; error?: string };
export type Paths = { app: string; data: string; node: string };

const WIN = process.platform === "win32";
export const pythonIn = (env: string) => (WIN ? join(env, "Scripts", "python.exe") : join(env, "bin", "python"));
const SAM_CKPT = "sam2.1_hiera_small.pt";
const SAM_URL = `https://dl.fbaipublicfiles.com/segment_anything_2/092824/${SAM_CKPT}`;

/** Run a command; each output line goes to `line`; on failure the last lines are the error. */
function run(cmd: string, args: string[], opts: { env?: NodeJS.ProcessEnv; cwd?: string; line?: (s: string) => void } = {}) {
  return new Promise<void>((ok, bad) => {
    const p = spawn(cmd, args, { cwd: opts.cwd, env: { ...process.env, ...opts.env } });
    let tail: string[] = [];
    const feed = (b: Buffer) => b.toString().split(/[\r\n]+/).filter((s) => s.trim()).forEach((s) => { tail = [...tail, s].slice(-12); opts.line?.(s); });
    p.stdout.on("data", feed); p.stderr.on("data", feed);
    p.on("error", (e) => bad(new Error(`${cmd}: ${e.message}`)));
    p.on("close", (code) => (code ? bad(new Error(tail.join("\n") || `${cmd} thoát với mã ${code}`)) : ok()));
  });
}

export function createSetup(p: Paths) {
  const rt = join(p.data, "runtime");
  const uv = join(p.app, "bin", WIN ? "uv.exe" : "uv");
  const uvEnv = { UV_PYTHON_INSTALL_DIR: join(rt, "python"), UV_CACHE_DIR: join(rt, "uv-cache"), UV_NO_CONFIG: "1", UV_PYTHON_PREFERENCE: "only-managed" };
  const core = join(rt, "py"), ml = join(rt, "py-ml"), models = join(rt, "models", "sam2");
  const req = (f: string) => readFileSync(join(p.app, "python", f), "utf8");
  // a marker per environment: what it was made from, so a new version of the app with other requirements rebuilds it
  const stamp = (f: string) => createHash("sha1").update(req(f)).digest("hex").slice(0, 12);
  const marked = (env: string, f: string) => existsSync(pythonIn(env)) && existsSync(join(env, ".stamp")) && readFileSync(join(env, ".stamp"), "utf8") === stamp(f);
  const browserMark = join(rt, ".browser");

  const setup: Stage = { ready: marked(core, "requirements.txt") && existsSync(browserMark), busy: false, pct: 0, msg: "" };
  const sam: Stage & { installed: boolean } = { ready: true, busy: false, pct: 0, msg: "", installed: marked(ml, "requirements-sam.txt") && existsSync(join(models, SAM_CKPT)) };

  async function venv(env: string, f: string, at: (v: number, msg: string) => void, span: [number, number]) {
    at(span[0], "Tải Python 3.11");
    await run(uv, ["python", "install", "3.11"], { env: uvEnv });
    await run(uv, ["venv", env, "--python", "3.11", "--clear"], { env: uvEnv });
    // uv names each package as it goes: a step of progress per line, never past the span
    let k = 0;
    at(span[0] + 0.1 * (span[1] - span[0]), "Cài thư viện");
    await run(uv, ["pip", "install", "--python", pythonIn(env), "-r", join(p.app, "python", f)], {
      env: uvEnv, line: (s) => {
        const m = s.match(/^\s*(?:Downloading|Downloaded|Building|Built|Installed)\s+(\S+)/);
        if (m) at(span[0] + (0.1 + 0.85 * (1 - 1 / (1 + ++k / 6))) * (span[1] - span[0]), `Cài thư viện: ${m[1]}`);
      },
    });
    writeFileSync(join(env, ".stamp"), stamp(f));
  }

  async function first() {
    if (setup.busy || setup.ready) return;
    Object.assign(setup, { busy: true, error: undefined, pct: 0.02, msg: "Bắt đầu" });
    const at = (v: number, msg: string) => Object.assign(setup, { pct: Math.max(setup.pct, v), msg });
    try {
      mkdirSync(rt, { recursive: true });
      if (!marked(core, "requirements.txt")) await venv(core, "requirements.txt", at, [0.02, 0.6]);
      if (!existsSync(browserMark)) {
        at(0.6, "Tải trình dựng hình (Chrome Headless)");
        await run(p.node, [join(p.app, "dist", "render.cjs"), "--browser"], {
          cwd: p.data, env: { ELECTRON_RUN_AS_NODE: "1" },
          line: (s) => { const m = s.match(/^P ([\d.]+)/); if (m) at(0.6 + 0.38 * Number(m[1]), `Tải trình dựng hình ${Math.round(Number(m[1]) * 100)}%`); },
        });
        writeFileSync(browserMark, new Date().toISOString());
      }
      Object.assign(setup, { ready: true, busy: false, pct: 1, msg: "Xong" });
    } catch (e) {
      Object.assign(setup, { busy: false, error: (e as Error).message.slice(-1500) });
    }
  }

  async function installSam() {
    if (sam.busy || sam.installed) return;
    Object.assign(sam, { busy: true, error: undefined, pct: 0.01, msg: "Bắt đầu" });
    const at = (v: number, msg: string) => Object.assign(sam, { pct: Math.max(sam.pct, v), msg });
    try {
      if (!marked(ml, "requirements-sam.txt")) await venv(ml, "requirements-sam.txt", at, [0.01, 0.75]);
      const ckpt = join(models, SAM_CKPT);
      if (!existsSync(ckpt)) {
        mkdirSync(models, { recursive: true });
        at(0.75, "Tải mô hình SAM 2");
        const r = await fetch(SAM_URL);
        if (!r.ok || !r.body) throw new Error(`Không tải được mô hình (${r.status})`);
        const size = Number(r.headers.get("content-length") ?? 0);
        let got = 0;
        const body = Readable.fromWeb(r.body as any);
        body.on("data", (c: Buffer) => { got += c.length; if (size) at(0.75 + 0.24 * (got / size), `Tải mô hình SAM 2 ${Math.round((got / size) * 100)}%`); });
        await pipeline(body, createWriteStream(ckpt + ".part"));
        renameSync(ckpt + ".part", ckpt);
      }
      Object.assign(sam, { installed: true, busy: false, pct: 1, msg: "Xong" });
    } catch (e) {
      rmSync(join(models, SAM_CKPT + ".part"), { force: true });
      Object.assign(sam, { busy: false, error: (e as Error).message.slice(-1500) });
    }
  }

  return { setup, sam, first, installSam, python: pythonIn(core), samPython: pythonIn(ml), samModels: models };
}
