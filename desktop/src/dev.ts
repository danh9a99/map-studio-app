/** Run the desktop app's server without Electron, on a scratch data folder: `npm run dev` → the URL it prints. */
import { join, resolve } from "node:path";
import { startServer } from "./server";

const here = resolve(import.meta.dirname);
const data = process.env.MAP_DATA ?? join(here, "..", ".dev-data");
const { port } = await startServer({ app: join(here, "..", "app"), data, version: "dev", node: process.execPath, encrypt: (s) => "plain:" + s,
  decrypt: (s) => s.replace(/^plain:/, ""), vite: true, port: Number(process.env.PORT ?? 4330) });
console.log(`Map Studio (dev) → http://localhost:${port}  data: ${data}`);
