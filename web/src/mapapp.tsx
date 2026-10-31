/**
 * The desktop map app (desktop/): the map editor, with the first-run setup screen and the
 * settings (which AI writes the draft, with the user's own key; the SAM 2 add-on).
 */
import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { MapDock, MapStage, useMap } from "./mapeditor";

type Stage = { ready: boolean; busy: boolean; pct: number; msg: string; error?: string };
type AppState = {
  version: string;
  setup: Stage;
  sam: Stage & { installed: boolean };
  settings: { ai: "none" | "anthropic" | "gemini"; model: string; keys: { anthropic: boolean; gemini: boolean } };
};

const MODELS: Record<"anthropic" | "gemini", [string, string][]> = {
  anthropic: [["claude-haiku-5-5", "Haiku 5.5 (rẻ nhất)"], ["claude-sonnet-5-5", "Sonnet 5.5 (cân bằng)"], ["claude-opus-5-5", "Opus 5.5 (tốt nhất)"]],
  gemini: [["gemini-flash-latest", "Gemini Flash (rẻ)"], ["gemini-pro-latest", "Gemini Pro (tốt hơn)"]],
};
const KEY_HELP = {
  anthropic: { url: "https://platform.claude.com/settings/keys", where: "platform.claude.com, mục API Keys" },
  gemini: { url: "https://aistudio.google.com/apikey", where: "aistudio.google.com, mục Get API key" },
};

const send = (url: string, data: unknown, method = "POST") =>
  fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) }).then(async (r) => {
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error ?? `Lỗi ${r.status}`);
    return j;
  });

function upload(f: File, onProgress: (p: number) => void) {
  return new Promise<string>((ok, bad) => {
    const x = new XMLHttpRequest();
    x.open("POST", "/api/upload");
    x.setRequestHeader("X-Filename", encodeURIComponent(f.name));
    x.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    x.onload = () => (x.status === 200 ? ok(JSON.parse(x.responseText).path) : bad(new Error(x.responseText)));
    x.onerror = () => bad(new Error("upload failed"));
    x.send(f);
  });
}

function useApp() {
  const [st, setSt] = useState<AppState | null>(null);
  const load = () => fetch("/api/app").then((r) => r.json()).then(setSt).catch(() => undefined);
  const busy = !st || st.setup.busy || st.sam.busy;
  useEffect(() => { load(); const t = setInterval(load, busy ? 800 : 4000); return () => clearInterval(t); }, [busy]);
  return { st, load };
}

function Bar({ pct }: { pct: number }) {
  return <div className="me-modal-bar"><div style={{ width: `${Math.round(pct * 100)}%` }} /></div>;
}

/** First run: Python, its libraries and the render's browser are fetched once; nothing else works before that. */
function Setup({ s, retry }: { s: Stage; retry: () => void }) {
  return (
    <div className="me-modal-back">
      <div className={`me-modal ma-setup ${s.error ? "bad" : ""}`}>
        <div className="me-modal-head">
          {s.error ? <span className="me-modal-mark ma-mark">!</span> : <span className="me-spin" />}
          <div><b className="me-modal-title">{s.error ? "Cài đặt chưa xong" : "Chuẩn bị lần đầu"}</b>
            <span className="dim">Tải Python, thư viện xử lý video và trình dựng hình. Chỉ làm một lần, cần mạng.</span></div>
          {!s.error ? <span className="me-modal-pct">{Math.round(s.pct * 100)}%</span> : null}
        </div>
        {!s.error ? <><Bar pct={s.pct} /><div className="dim">{s.msg}</div></> : (
          <>
            <div className="me-modal-err">{s.error}</div>
            <div className="me-btnrow"><button className="btn" onClick={retry}>Thử lại</button></div>
          </>
        )}
      </div>
    </div>
  );
}

function Settings({ st, close, reload }: { st: AppState; close: () => void; reload: () => void }) {
  const [ai, setAi] = useState(st.settings.ai);
  const [model, setModel] = useState(st.settings.model);
  const [key, setKey] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const pick = (v: AppState["settings"]["ai"]) => { setAi(v); setKey(""); setErr(null); if (v !== "none") setModel(MODELS[v][Math.min(1, MODELS[v].length - 1)][0]); };
  const hasKey = ai !== "none" && st.settings.keys[ai];
  const save = async () => {
    if (ai !== "none" && !hasKey && !key.trim()) return setErr("Dán API key trước khi lưu");
    setSaving(true); setErr(null);
    try {
      await send("/api/settings", { ai, model, ...(key.trim() ? { key: key.trim() } : {}) }, "PUT");
      reload(); close();
    } catch (e) { setErr((e as Error).message); } finally { setSaving(false); }
  };
  const forget = async () => { await send("/api/settings", { ai: "none", forget: ai }, "PUT").catch(() => undefined); reload(); close(); };
  return (
    <div className="me-modal-back" onClick={close}>
      <div className="me-modal ma-settings" onClick={(e) => e.stopPropagation()}>
        <b className="me-modal-title">Cài đặt</b>
        <section>
          <div className="ma-label">AI vẽ bản nháp</div>
          <div className="dim ma-note">AI đọc yêu cầu của bạn và chọn đường, khu vực, màu, kiểu nét. Dùng API key của chính bạn, tiền tính vào tài khoản của bạn
            (khoảng vài trăm đến vài nghìn đồng mỗi lần vẽ nháp). Không dùng AI thì app tự chọn các đường lớn nhất, bạn sửa tay.</div>
          <div className="me-chips">
            {([["anthropic", "Claude"], ["gemini", "Gemini"], ["none", "Không dùng AI"]] as const).map(([v, l]) =>
              <button key={v} className={`me-chipbtn ${ai === v ? "on" : ""}`} onClick={() => pick(v)}>{l}</button>)}
          </div>
          {ai !== "none" ? (
            <div className="ma-form">
              <label>Model
                <select value={model} onChange={(e) => setModel(e.target.value)}>
                  {MODELS[ai].map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
              </label>
              <label>API key {hasKey ? <span className="ma-ok">đã lưu</span> : null}
                <input type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder={hasKey ? "Dán key mới để thay" : "Dán key vào đây"} autoComplete="off" spellCheck={false} />
              </label>
              <div className="dim ma-note">Lấy key tại <a href={KEY_HELP[ai].url} target="_blank" rel="noreferrer">{KEY_HELP[ai].where}</a>. Key được mã hoá và chỉ lưu trên máy này.
                {hasKey ? <> <button className="ma-link" onClick={forget}>Xoá key</button></> : null}</div>
            </div>
          ) : null}
        </section>
        <section>
          <div className="ma-label">Tách toà nhà (SAM 2)</div>
          {st.sam.installed ? <div className="dim ma-note"><span className="ma-ok">Đã cài</span> Bấm vào toà nhà trong khung hình để tách và làm nổi.</div> : st.sam.busy ? (
            <><Bar pct={st.sam.pct} /><div className="dim ma-note">{st.sam.msg}</div></>
          ) : (
            <>
              <div className="dim ma-note">Cần tải thêm khoảng 1 đến 2 GB. Máy Mac chip M hoặc máy có card NVIDIA chạy nhanh; máy khác vẫn chạy nhưng chậm.</div>
              {st.sam.error ? <div className="me-modal-err">{st.sam.error}</div> : null}
              <button className="btn ghost small" onClick={() => send("/api/sam/install", {}).then(reload).catch((e) => setErr(e.message))}>Tải và cài SAM 2</button>
            </>
          )}
        </section>
        {err ? <div className="me-modal-err">{err}</div> : null}
        <div className="me-btnrow">
          <button className="btn ghost" onClick={close}>Đóng</button>
          <button className="btn" onClick={save} disabled={saving}>{saving ? "Đang lưu…" : "Lưu"}</button>
        </div>
        <div className="dim ma-note">Phiên bản {st.version}</div>
      </div>
    </div>
  );
}

function App() {
  const { st, load } = useApp();
  const map = useMap(upload);
  const [sel, setSel] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const aiName = st?.settings.ai === "anthropic" ? "Claude" : st?.settings.ai === "gemini" ? "Gemini" : null;
  return (
    <div className="app">
      <nav className="panel left">
        <div className="dock">
          <div className="dock-head"><b>Bản đồ trên clip flycam</b></div>
          <div className="dock-body"><MapDock m={map} sel={sel} setSel={setSel} /></div>
        </div>
      </nav>
      <header className="top">
        <div className="brand"><span className="dot" />Map Studio</div>
        <div className="top-job" />
        <div className="top-actions">
          <span className={`badge ${aiName ? "ok" : ""}`}>{aiName ? `AI: ${aiName}` : "Chưa bật AI"}</span>
          <button className="btn ghost small" onClick={() => setOpen(true)} disabled={!st}>Cài đặt</button>
        </div>
      </header>
      <section className="panel drone-stage"><MapStage m={map} sel={sel} setSel={setSel} /></section>
      {st && !st.setup.ready ? <Setup s={st.setup} retry={() => send("/api/setup/retry", {}).then(load)} /> : null}
      {st && st.setup.ready && open ? <Settings st={st} close={() => setOpen(false)} reload={load} /> : null}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
