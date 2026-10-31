/**
 * Map Studio (Electron): starts the local server on the user's data folder and shows the map editor in a window.
 * Keys are encrypted with the OS keychain (safeStorage); links open in the browser; updates come from GitHub Releases.
 */
import { app, BrowserWindow, dialog, safeStorage, shell } from "electron";
import electronUpdater from "electron-updater";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { startServer } from "./server";

const encrypt = (s: string) => (safeStorage.isEncryptionAvailable() ? "os:" + safeStorage.encryptString(s).toString("base64") : "plain:" + s);
const decrypt = (s: string) => (s.startsWith("os:") ? safeStorage.decryptString(Buffer.from(s.slice(3), "base64")) : s.replace(/^plain:/, ""));

if (!app.requestSingleInstanceLock()) app.quit();

app.whenReady().then(async () => {
  let port: number;
  try {
    ({ port } = await startServer({ app: app.getAppPath(), data: app.getPath("userData"), version: app.getVersion(), node: process.execPath, encrypt, decrypt }));
  } catch (e) {
    dialog.showErrorBox("Map Studio không khởi động được", (e as Error).stack ?? String(e));
    return app.quit();
  }
  const win = new BrowserWindow({ width: 1600, height: 1000, minWidth: 1200, minHeight: 760, backgroundColor: "#08090c", title: "Map Studio",
    autoHideMenuBar: true, webPreferences: { contextIsolation: true, sandbox: true } });
  const local = (u: string) => u.startsWith(`http://127.0.0.1:${port}/`);
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url) && !local(url)) shell.openExternal(url); return { action: "deny" }; });
  win.webContents.on("will-navigate", (e, url) => { if (!local(url)) { e.preventDefault(); if (/^https?:/.test(url)) shell.openExternal(url); } });
  await win.loadURL(`http://127.0.0.1:${port}/`);
  app.on("second-instance", () => { if (win.isMinimized()) win.restore(); win.focus(); });
  // unsigned macOS builds cannot update themselves: the check fails quietly there
  if (app.isPackaged && existsSync(join(process.resourcesPath, "app-update.yml"))) electronUpdater.autoUpdater.checkForUpdatesAndNotify().catch(() => undefined);
});

app.on("window-all-closed", () => app.quit());
