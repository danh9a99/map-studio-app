/**
 * Builds Map Studio's app folder (what electron-builder packs):
 *
 *   app/dist/main.cjs, render.cjs   Electron main process + server, the renderer run by drone-map.py
 *   app/ui                          the map editor page (Vite, from web/map.html)
 *   app/site                        the render bundle (Remotion, MapShot only: src/map-index.ts)
 *   app/scripts, app/python         the Python scripts and their requirements
 *   app/bin/uv                      uv, which fetches Python on the user's machine (UV_BIN, else the one on PATH)
 *
 *   node build.mjs           everything
 *   node build.mjs --code    skip the editor page and the render bundle (dev: the page comes from Vite)
 */
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build as esbuild } from "esbuild";

const HERE = dirname(fileURLToPath(import.meta.url));
const REMOTION = join(HERE, "..");
const APP = join(HERE, "app");
const WIN = process.platform === "win32";
const codeOnly = process.argv.includes("--code");

const step = (s) => console.log(`\n▸ ${s}`);

step("main process and renderer");
const common = { bundle: true, platform: "node", target: "node22", format: "cjs", logLevel: "warning",
  external: ["electron", "electron-updater", "@remotion/renderer", "ffmpeg-static", "ffprobe-static", "vite"] };
await esbuild({ ...common, entryPoints: [join(HERE, "src", "main.ts")], outfile: join(APP, "dist", "main.cjs") });
await esbuild({ ...common, entryPoints: [join(HERE, "src", "render.ts")], outfile: join(APP, "dist", "render.cjs") });

step("Python scripts");
mkdirSync(join(APP, "scripts"), { recursive: true });
for (const f of ["drone-map.py", "track.py", "mapcolor.py", "colorgrade.py", "segment.py"]) copyFileSync(join(REMOTION, "scripts", f), join(APP, "scripts", f));
mkdirSync(join(APP, "python"), { recursive: true });
for (const f of ["requirements.txt", "requirements-sam.txt"]) copyFileSync(join(HERE, "python", f), join(APP, "python", f));

step("uv");
const uv = process.env.UV_BIN ?? execFileSync(WIN ? "where" : "which", ["uv"], { encoding: "utf8" }).split(/\r?\n/)[0].trim();
mkdirSync(join(APP, "bin"), { recursive: true });
copyFileSync(uv, join(APP, "bin", WIN ? "uv.exe" : "uv"));
if (!WIN) chmodSync(join(APP, "bin", "uv"), 0o755);

if (!codeOnly) {
  step("editor page");
  const { build: vite } = await import("vite");
  await vite({ root: join(REMOTION, "web"), base: "/", publicDir: false, logLevel: "warn",
    build: { outDir: join(APP, "ui"), emptyOutDir: true, chunkSizeWarningLimit: 4000, rollupOptions: { input: join(REMOTION, "web", "map.html") } } });

  step("render bundle");
  const { bundle } = await import("@remotion/bundler");
  rmSync(join(APP, "site"), { recursive: true, force: true });
  const empty = mkdtempSync(join(tmpdir(), "map-public-"));
  let shown = -10;
  await bundle({ entryPoint: join(REMOTION, "src", "map-index.ts"), outDir: join(APP, "site"), publicDir: empty,
    onProgress: (p) => { if (p - shown >= 10) { shown = p; process.stdout.write(` ${p}%`); } } });
  rmSync(empty, { recursive: true, force: true });
  console.log();
}
console.log("\n✓ app/ ready");
