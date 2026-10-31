/**
 * The desktop app's renderer, run by drone-map.py in place of `npx remotion render` (MAP_RENDER), with the same
 * arguments and the same progress lines, on the prebuilt bundle in the user's data folder (MAP_SITE):
 *
 *   render.cjs <composition> <out.mp4> --props=<json> [--crf=18]
 *   render.cjs --browser            fetch the headless browser once (first-run setup), printing "P <0..1>"
 *
 * Run with the cwd in the data folder: Remotion keeps its browser under <cwd>/.remotion.
 */
import { ensureBrowser, renderMedia, selectComposition } from "@remotion/renderer";

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === "--browser") {
    await ensureBrowser({ onBrowserDownload: () => ({ version: null, onProgress: ({ percent }) => console.log(`P ${percent.toFixed(3)}`) }) });
    return;
  }
  const [id, out] = args;
  const flag = (k: string) => args.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
  const inputProps = JSON.parse(flag("props") ?? "{}");
  const serveUrl = process.env.MAP_SITE;
  if (!id || !out || !serveUrl) throw new Error("render.cjs <composition> <out.mp4> --props=<json> (MAP_SITE set)");
  const composition = await selectComposition({ serveUrl, id, inputProps });
  const total = composition.durationInFrames;
  let last = -1;
  await renderMedia({
    composition, serveUrl, inputProps, codec: "h264", outputLocation: out, crf: Number(flag("crf") ?? 18),
    // the same lines as the CLI, read by drone-map.py's progress parser
    onProgress: ({ renderedFrames, encodedFrames, renderEstimatedTime }) => {
      const done = renderedFrames >= total;
      const n = done ? encodedFrames : renderedFrames;
      if (n === last) return;
      last = n;
      if (!done) console.log(`Rendered ${renderedFrames}/${total}, time remaining: ${Math.ceil(renderEstimatedTime / 1000)}s`);
      else console.log(`Encoded ${encodedFrames}/${total}`);
    },
  });
}

main().catch((e) => { console.error(e instanceof Error ? e.stack ?? e.message : e); process.exit(1); });
