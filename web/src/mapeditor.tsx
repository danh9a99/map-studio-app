/**
 * "Bản đồ": roads, road names, highlighted areas, ground text and pins on aerial footage, drafted by Claude from the
 * user's request and then drawn over by the user. Three steps:
 *   1 · clip, stretch, request, frame, look and colour (delog, own LUT) → scripts/drone-map.py start
 *   2 · the draft: DJI clips fit themselves from the flight data, other clips ask for a few points one at a time
 *   3 · the editor: the MapShot composition plays live in the Player; when paused, layers can be picked, dragged,
 *       drawn and deleted on any frame (positions go back to the first frame through the tracking), styled from a
 *       gallery that previews on hover, then exported.
 */
import React, { useEffect, useMemo, useRef, useState } from "react";
import { Player, type PlayerRef } from "@remotion/player";
import {
  ASPECTS, COLORS, LINE_SIZES, LINE_STYLES, LineArt, ROAD_M, MapShot, NAME_STYLES, docFrames, nameSpot, outSize, polyLen, trimOf, useCameras, useProjection, type Aspect,
  type BuildingLayer, type Delog, type Grade, type Layer, type LineStyle, type MapDoc, type NameStyle, type Pt, type RoadLayer,
} from "../../src/mapshot/MapShot";
import { CALLOUT_ICONS, Callout, type CalloutIcon } from "../../src/mapshot/Callout";
import { GLASS, HIGHLIGHTS, prismEdges } from "../../src/mapshot/Building";
import { segPolys, useSegs } from "../../src/mapshot/Seg";
import { Road3D, isRoad3D } from "../../src/mapshot/Road3D";

type Road = { name: string; kind: string; seen: number; preview: Pt[][] };
type State = {
  name: string; running: boolean;
  status: { step: string; msg?: string; video?: string; at?: string; time?: number;
    /** the job this step belongs to: its stages, which one is going, how far it is (0..1, when known), when it began */
    job?: string; stages?: string[]; stage?: number; pct?: number; started?: number } | null;
  meta: { w: number; h: number; center?: [number, number]; tiles?: [number, number]; zoom?: number; tilesAcross?: number; flight?: { lat: number; lon: number } | null;
    track?: { quality: "good" | "ok" | "poor"; weak: [number, number][] }; clip?: string; start?: number; dur?: number; clipDur?: number } | null;
  fit: { how: string; roads: Road[]; areas: { name: string; points: Pt[] }[] } | null;
  doc: MapDoc | null;
  plan: { why?: string } | null;
  request: { clip: string; request: string; aspect: Aspect; color?: Color } | null;
  color: { delog: string; asked: string } | null;
};
type Color = { delog: string; lut: string | null; strength: number; look: string };
type Tool = "select" | "road" | "area" | "building" | "seg" | "label" | "pin" | "callout" | "frame";

const STEP_LABEL: Record<string, string> = {
  prep: "Cắt đoạn và bám chuyển động mặt đất", place: "Tải ảnh vệ tinh và bản đồ đường phố", fit: "Khớp bản đồ vào khung hình",
  draft: "AI đang đọc yêu cầu và vẽ nháp", color: "Chỉnh màu clip", render: "Đang xuất video",
  cut: "Cắt đoạn mới và bám chuyển động", move: "Dời các lớp đã vẽ sang đoạn mới", build: "Tìm toà nhà cao có sẵn",
};
const EXAMPLES = ["Làm nổi đường chính và ghi tên đường", "Khoanh công trình lớn nhất và đặt tên", "Vẽ mũi tên chỉ đường từ vòng xoay ra biển",
  "Chỉ ghi tên các con đường, không tô màu"];
const LOOKS = [{ id: "gold", name: "Nắng ấm", hint: "ánh vàng, nền dịu" }, { id: "mint", name: "Ánh xanh", hint: "light leak mint" }, { id: "clean", name: "Giữ màu", hint: "không phủ màu" }] as const;
const DELOG = [{ id: "auto", name: "Tự nhận biết" }, { id: "none", name: "Không delog" }, { id: "dlogm", name: "D-Log M" }, { id: "dlog", name: "D-Log" }, { id: "hlg", name: "HLG" }];

const post = (url: string, body: unknown, method = "POST") => fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
  .then(async (r) => { const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error ?? "Lỗi"); return j; });
const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const uid = () => Math.random().toString(36).slice(2, 8);

// ── state ────────────────────────────────────────────────────────────────────
export function useMap(upload: (f: File, onProgress: (p: number) => void) => Promise<string>) {
  const [name, setNameRaw] = useState(() => { try { return localStorage.getItem("map-name") ?? ""; } catch { return ""; } });
  // the clip open right now: a reply or a save that started for another clip must not land on this one
  const nameRef = useRef(name);
  const setName = (n: string) => { nameRef.current = n; setNameRaw(n); try { localStorage.setItem("map-name", n); } catch { /* private mode */ } };
  const [st, setSt] = useState<State | null>(null), [err, setErr] = useState("");
  // step 1 form
  const [clip, setClip] = useState(""), [prog, setProg] = useState<number | null>(null);
  const [info, setInfo] = useState<{ dur: number; dji: boolean; thumbs: string[] } | null>(null), [probing, setProbing] = useState(false);
  const [start, setStart] = useState(0), [dur, setDur] = useState(8);
  const [request, setRequest] = useState(""), [aspect, setAspect] = useState<Aspect>("16:9"), [look, setLook] = useState<"gold" | "mint" | "clean">("gold");
  const [center, setCenter] = useState("");
  const [color, setColor] = useState<Color>({ delog: "auto", lut: null, strength: 1, look: "none" });
  const [fresh, setFresh] = useState(!name);
  // step 2 guided points
  const [pairs, setPairs] = useState<{ f?: Pt; m?: [number, number] }[]>([]);
  const [compare, setCompare] = useState(false);
  // step 3 the document, with undo
  const [doc, setDocRaw] = useState<MapDoc | null>(null);
  const hist = useRef<{ past: MapDoc[]; future: MapDoc[] }>({ past: [], future: [] });
  const lastJob = useRef("");
  const docOf = useRef("");   // which clip the doc in hand belongs to
  const load = () => {
    const n = nameRef.current;
    if (!n) return;
    fetch(`/api/map/${n}`).then((r) => r.json()).then((j: State) => { if (n === nameRef.current) setSt(j); }).catch(() => undefined);
  };
  const busy = !!st && (st.running || Object.keys(STEP_LABEL).includes(st.status?.step ?? ""));
  useEffect(() => { setDocRaw(null); setSt(null); docOf.current = ""; hist.current = { past: [], future: [] }; load(); }, [name]);
  useEffect(() => { if (!busy) return; const t = setInterval(load, 1200); return () => clearInterval(t); }, [busy, name]);
  // the server's document: taken whole after a draft (or the first time), only its clip after a colour job
  useEffect(() => {
    if (!st?.doc || busy || st.name !== nameRef.current) return;
    if (!doc || lastJob.current === "draft") { setDocRaw(st.doc); docOf.current = st.name; hist.current = { past: [], future: [] }; }
    else if (st.doc.clip !== doc.clip) setDocRaw({ ...doc, clip: st.doc.clip, source: st.doc.source, baked: st.doc.baked, grade: doc.grade ?? st.doc.grade });
    lastJob.current = "";
  }, [st?.doc?.clip, st?.status?.time, busy]);
  // edits save themselves
  const saveT = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const save = (d: MapDoc) => (docOf.current && docOf.current === nameRef.current ? post(`/api/map/${docOf.current}/doc`, { doc: d }, "PUT").catch((e) => setErr(e.message)) : Promise.resolve());
  const setDoc = (d: MapDoc, record = true) => {
    if (record && doc) { hist.current.past.push(doc); if (hist.current.past.length > 80) hist.current.past.shift(); hist.current.future = []; }
    setDocRaw(d);
    clearTimeout(saveT.current); saveT.current = setTimeout(() => save(d), 600);
  };
  const run = async (job: string, f: () => Promise<unknown>) => { setErr(""); lastJob.current = job; try { await f(); setTimeout(load, 300); } catch (e) { setErr((e as Error).message); lastJob.current = ""; } };
  return {
    name, st, err, setErr, busy, clip, setClip, prog, info, probing, start, setStart, dur, setDur, request, setRequest, aspect, setAspect, look, setLook,
    center, setCenter, color, setColor, fresh, setFresh, pairs, setPairs, doc, setDoc, compare, setCompare,
    undo: () => { const p = hist.current.past.pop(); if (p && doc) { hist.current.future.push(doc); setDoc(p, false); } },
    redo: () => { const n = hist.current.future.pop(); if (n && doc) { hist.current.past.push(doc); setDoc(n, false); } },
    open: (n: string) => { setName(n); setFresh(false); },
    pick: async (f: File) => { setErr(""); setProg(0); try { const p = await upload(f, setProg); setClip(p); await probe(p); } catch (e) { setErr((e as Error).message); } setProg(null); },
    probe: (p: string) => probe(p),
    uploadLut: async (f: File) => { setErr(""); try { const p = await upload(f, () => undefined); setColor((c) => ({ ...c, lut: p })); } catch (e) { setErr((e as Error).message); } },
    start_: () => run("draft", async () => {
      const r = await post("/api/map", { clip, start, dur, request, aspect, look, center, color });
      setPairs([]); setName(r.name); setFresh(false);
    }),
    place: () => run("draft", () => post(`/api/map/${name}/place`, { center })),
    // on a doc already drawn on, the hand-drawn layers are kept and only the map layers are redone
    points: async () => { if (doc) { clearTimeout(saveT.current); await save(doc); } return run("draft", () => post(`/api/map/${name}/points`, { pairs: pairs.filter((p) => p.f && p.m).map((p) => [...p.f!, ...p.m!]), keep: !!doc })); },
    refit: (cancel = false) => { setPairs([]); return post(`/api/map/${name}/refit`, { cancel }).then(() => { load(); }); },
    redraft: (req: string) => run("draft", () => post(`/api/map/${name}/draft`, { request: req })),
    regrade: (c: Color, still: boolean) => { setCompare(still); return run(still ? "still" : "color", () => post(`/api/map/${name}/color`, { ...c, still })); },
    render: async () => { if (doc) await save(doc); return run("render", () => post(`/api/map/${name}/render`, {})); },
    // a stretch outside the cut: saved first (no late autosave over the job), then cut and tracked again on the server
    // a real building clicked on (frame of the cut, fractions of the frame), followed through the clip by SAM 2
    segment: async (frame: number, points: number[][], highlight = true) => { clearTimeout(saveT.current); if (doc) await save(doc); return run("draft", () => post(`/api/map/${name}/segment`, { frame, points, highlight })); },
    // tall buildings from the map, as real ones the ground layers go behind
    occluders: async () => { clearTimeout(saveT.current); if (doc) await save(doc); return run("draft", () => post(`/api/map/${name}/occluders`, {})); },
    recut: async (start: number, dur: number) => { clearTimeout(saveT.current); if (doc) await save(doc); return run("draft", () => post(`/api/map/${name}/recut`, { start, dur })); },
  };
  async function probe(p: string) {
    setInfo(null); setProbing(true);
    const r = await post("/api/map/thumbs", { clip: p }).finally(() => setProbing(false));
    setInfo(r); setStart(Math.max(0, Math.min(start, r.dur - 2))); setDur(Math.min(8, Math.max(2, r.dur)));
  }
}
export type MapApi = ReturnType<typeof useMap>;

// ── the dock ─────────────────────────────────────────────────────────────────
export function MapDock({ m, sel, setSel }: { m: MapApi; sel: string | null; setSel: (s: string | null) => void }) {
  const step = m.st?.status?.step ?? "";
  const [runs, setRuns] = useState<{ name: string; request: { request?: string; clip?: string } }[]>([]);
  useEffect(() => { fetch("/api/map").then((r) => r.json()).then(setRuns).catch(() => undefined); }, [m.name, m.fresh]);
  if (m.fresh || !m.name) return <div className="me-dock"><Setup m={m} runs={runs} /></div>;
  return (
    <div className="me-dock">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <span className="dim me-clipname" title={m.st?.request?.clip}>{m.st?.request?.clip?.split("/").pop()}</span>
        <button className="btn ghost small" onClick={() => m.setFresh(true)}>Clip mới</button>
      </div>
      {step === "error" ? <div className="err">{m.st?.status?.msg}</div> : null}
      {m.err ? <div className="err">{m.err}</div> : null}
      {step === "need-place" ? (
        <div className="me-card">
          <b>Clip này không có GPS</b>
          <div className="dim">Dán link Google Maps hoặc toạ độ nơi quay.</div>
          <input type="text" placeholder="https://maps.google.com/…@13.76,109.22 hoặc 13.76, 109.22" value={m.center} onChange={(e) => m.setCenter(e.target.value)} />
          <button className="btn wide" disabled={!m.center || m.busy} onClick={m.place}>Tải bản đồ nơi này</button>
        </div>
      ) : null}
      {step === "need-points" ? <PointsGuide m={m} /> : null}
      {m.doc && step !== "need-points" ? <Layers m={m} sel={sel} setSel={setSel} /> : null}
    </div>
  );
}

function Setup({ m, runs }: { m: MapApi; runs: { name: string; request: { request?: string; clip?: string } }[] }) {
  const [drag, setDrag] = useState(false);
  const lutIn = useRef<HTMLInputElement>(null);
  return (
    <div className="me-dock">
      <label className="lbl">1 · Clip</label>
      <div className={`me-drop ${drag ? "on" : ""}`} onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)}
        onDrop={(e) => { e.preventDefault(); setDrag(false); const f = e.dataTransfer.files[0]; if (f) m.pick(f); }}>
        <input type="file" accept="video/*" id="me-file" hidden onChange={(e) => e.target.files?.[0] && m.pick(e.target.files[0])} />
        <label htmlFor="me-file"><b>Kéo clip flycam vào đây</b><span className="dim">hoặc bấm để chọn file</span></label>
        {m.prog !== null ? <div className="bar" style={{ width: "100%" }}><div style={{ width: `${Math.round(m.prog * 100)}%` }} /></div> : null}
      </div>
      <div className="row" style={{ marginTop: 6 }}>
        <input type="text" placeholder="…hoặc dán đường dẫn file trên máy" value={m.clip} onChange={(e) => m.setClip(e.target.value)} />
        <button className="btn ghost small" disabled={!m.clip} onClick={() => m.probe(m.clip).catch((e) => m.setErr(e.message))}>Mở</button>
      </div>
      {m.info ? <RangePicker m={m} /> : m.probing ? <div className="me-note">Đang đọc clip và tạo ảnh xem trước…</div> : null}

      <label className="lbl">2 · Bạn muốn vẽ gì?</label>
      <textarea rows={3} placeholder="Ví dụ: làm nổi đường An Dương Vương, khoanh quảng trường, tiêu đề Quy Nhơn" value={m.request} onChange={(e) => m.setRequest(e.target.value)} />
      <div className="me-chips">{EXAMPLES.map((x) => <button key={x} className="me-chipbtn" onClick={() => m.setRequest(m.request ? `${m.request}. ${x}` : x)}>{x}</button>)}</div>

      <label className="lbl">3 · Khung và màu phủ</label>
      <div className="me-cards two">
        {ASPECTS.map((a) => (
          <button key={a.id} className={`me-opt ${m.aspect === a.id ? "on" : ""}`} onClick={() => m.setAspect(a.id)}>
            <span className="me-ratio" style={{ aspectRatio: a.id.replace(":", " / ") }} /><b>{a.name}</b><span className="dim">{a.hint}</span>
          </button>
        ))}
      </div>
      <div className="me-cards three">
        {LOOKS.map((l) => (
          <button key={l.id} className={`me-opt ${m.look === l.id ? "on" : ""}`} onClick={() => m.setLook(l.id)}>
            <span className={`me-swatch ${l.id}`} /><b>{l.name}</b><span className="dim">{l.hint}</span>
          </button>
        ))}
      </div>

      <label className="lbl">4 · Nơi quay</label>
      {m.info?.dji ? <div className="me-note ok">Clip DJI có GPS và hướng camera: bản đồ sẽ tự khớp.</div> : (
        <>
          <input type="text" placeholder="Link Google Maps hoặc toạ độ (13.7611, 109.2207)" value={m.center} onChange={(e) => m.setCenter(e.target.value)} />
          <div className="dim me-small">Clip không phải DJI: sau khi tải bản đồ, bạn chỉ cần bấm 3–4 điểm theo hướng dẫn.</div>
        </>
      )}

      <label className="lbl">5 · Màu clip</label>
      <div className="me-grid2">
        <span className="dim">Delog</span>
        <select value={m.color.delog} onChange={(e) => m.setColor({ ...m.color, delog: e.target.value })}>{DELOG.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select>
        <span className="dim">LUT riêng</span>
        <div className="row">
          <input ref={lutIn} type="file" accept=".cube" hidden onChange={(e) => e.target.files?.[0] && m.uploadLut(e.target.files[0])} />
          <button className="btn ghost small" onClick={() => lutIn.current?.click()}>{m.color.lut ? m.color.lut.split("/").pop()!.replace(/^\d+-/, "") : "Chọn file .cube"}</button>
          {m.color.lut ? <button className="btn ghost small" onClick={() => m.setColor({ ...m.color, lut: null })}>Bỏ</button> : null}
        </div>
        {m.color.lut ? <><span className="dim">Độ mạnh</span><div className="row"><input type="range" min={0} max={100} value={Math.round(m.color.strength * 100)}
          onChange={(e) => m.setColor({ ...m.color, strength: Number(e.target.value) / 100 })} /><span className="me-num">{Math.round(m.color.strength * 100)}%</span></div></> : null}
      </div>
      <div className="dim me-small">Xem trước trước/sau và chỉnh lại được ở bước sửa.</div>

      <button className="btn wide me-go" disabled={!m.clip || !m.info || (!m.info.dji && !m.center)} onClick={m.start_}>Vẽ nháp cho tôi</button>
      {m.err ? <div className="err">{m.err}</div> : null}

      {runs.length ? (
        <>
          <label className="lbl">Làm tiếp</label>
          {runs.map((r) => (
            <button key={r.name} className="me-run" onClick={() => m.open(r.name)}>
              <b>{(r.request.clip ?? r.name).split("/").pop()}</b><span className="dim">{r.request.request || "(không ghi yêu cầu)"}</span>
            </button>
          ))}
        </>
      ) : null}
    </div>
  );
}

/** The clip as a strip of thumbnails; the lit box is the stretch to work on: drag it, or drag its right edge. */
function RangePicker({ m }: { m: MapApi }) {
  const box = useRef<HTMLDivElement>(null);
  const D = m.info!.dur;
  const drag = (kind: "move" | "end") => (e: React.PointerEvent) => {
    e.preventDefault(); e.stopPropagation();
    const r = box.current!.getBoundingClientRect(), x0 = e.clientX, s0 = m.start, d0 = m.dur;
    const mv = (ev: PointerEvent) => {
      const dt = ((ev.clientX - x0) / r.width) * D;
      if (kind === "move") m.setStart(Math.round(Math.max(0, Math.min(D - d0, s0 + dt)) * 10) / 10);
      else m.setDur(Math.round(Math.max(2, Math.min(30, D - s0, d0 + dt)) * 10) / 10);
    };
    const up = () => { removeEventListener("pointermove", mv); removeEventListener("pointerup", up); };
    addEventListener("pointermove", mv); addEventListener("pointerup", up);
  };
  return (
    <div className="me-range">
      <div className="me-strip" ref={box} onPointerDown={(e) => {
        const r = box.current!.getBoundingClientRect();
        m.setStart(Math.round(Math.max(0, Math.min(D - m.dur, ((e.clientX - r.left) / r.width) * D - m.dur / 2)) * 10) / 10);
      }}>
        {m.info!.thumbs.map((t) => <img key={t} src={t} alt="" draggable={false} />)}
        <div className="me-sel" style={{ left: `${(m.start / D) * 100}%`, width: `${(m.dur / D) * 100}%` }} onPointerDown={drag("move")}>
          <span className="me-handle" onPointerDown={drag("end")} />
        </div>
      </div>
      <div className="dim me-small">Từ {mmss(m.start)} · dài {m.dur.toFixed(1)} giây · clip {mmss(D)}</div>
    </div>
  );
}


/** colours of the point pairs: the same colour marks the same spot on the video and on the satellite */
const PAIR_COLORS = ["#ff8a3d", "#3aa8ff", "#3dd68c", "#c084ff", "#ffd34d"];
/** where each pair is best taken: spread over the ground, far and near, left and right */
const PAIR_WHERE = ["phần xa, bên trái", "phần xa, bên phải", "phần gần, bên phải", "phần gần, bên trái", "ở giữa"];

/** a small picture of the idea: the same street corner, seen by the drone and seen from above */
const PairsPicture = () => (
  <svg viewBox="0 0 300 120" className="me-pairpic" aria-hidden>
    <g>
      <rect x="4" y="8" width="128" height="104" rx="8" fill="#1b1d22" stroke="#33363d" />
      <text x="68" y="24" textAnchor="middle" fontSize="10" fill="#9a968d">Video (nhìn xiên)</text>
      <path d="M18 108 L58 40 M118 108 L78 40 M10 86 L126 86 M30 62 L106 62" stroke="#6b6f78" strokeWidth="6" strokeLinecap="round" />
      <circle cx="47" cy="62" r="7" fill="#ff8a3d" stroke="#fff" strokeWidth="2" /><text x="47" y="65.5" textAnchor="middle" fontSize="9" fontWeight="800" fill="#fff">1</text>
    </g>
    <path d="M140 60 h22" stroke="#d6b36a" strokeWidth="2" strokeDasharray="4 3" /><path d="M160 55 l6 5 -6 5" fill="none" stroke="#d6b36a" strokeWidth="2" />
    <g>
      <rect x="170" y="8" width="126" height="104" rx="8" fill="#1b1d22" stroke="#33363d" />
      <text x="233" y="24" textAnchor="middle" fontSize="10" fill="#9a968d">Vệ tinh (nhìn từ trên)</text>
      <path d="M200 34 V106 M266 34 V106 M178 52 H290 M178 88 H290" stroke="#6b6f78" strokeWidth="7" strokeLinecap="round" />
      <circle cx="200" cy="52" r="7" fill="#ff8a3d" stroke="#fff" strokeWidth="2" /><text x="200" y="55.5" textAnchor="middle" fontSize="9" fontWeight="800" fill="#fff">1</text>
    </g>
  </svg>
);

function PointsGuide({ m }: { m: MapApi }) {
  const done = m.pairs.filter((p) => p.f && p.m).length;
  const cur = m.pairs.findIndex((p) => !p.f || !p.m), k = cur < 0 ? m.pairs.length : cur, p = m.pairs[k];
  const rows = Math.max(4, Math.min(5, k + 1));
  return (
    <div className="me-card me-pairs">
      <b>Ghép video với bản đồ</b>
      <div className="dim me-small">Clip không có dữ liệu bay, nên cần bạn chỉ ra vài chỗ <b>giống nhau</b> trên video và trên ảnh vệ tinh. Mỗi chỗ là một cặp: bấm trên video trước, rồi bấm đúng chỗ đó trên ảnh vệ tinh.</div>
      <PairsPicture />
      <ol className="me-pairlist">
        {Array.from({ length: rows }, (_, i) => {
          const q = m.pairs[i], ok = !!(q?.f && q?.m), on = i === k;
          return (
            <li key={i} className={ok ? "done" : on ? "on" : ""}>
              <span className="dot" style={{ background: PAIR_COLORS[i] }}>{ok ? "✓" : i + 1}</span>
              <div>
                <b>Cặp {i + 1}{i === 4 ? " (thêm, nếu muốn)" : ""}</b>
                <span className="dim">{ok ? "Đã ghép" : on ? (q?.f ? "Giờ bấm đúng chỗ đó trên ảnh vệ tinh bên phải" : `Bấm một chỗ trên video, ${PAIR_WHERE[i]}`) : `Một chỗ ${PAIR_WHERE[i]}`}</span>
              </div>
            </li>
          );
        })}
      </ol>
      <details className="me-tips">
        <summary>Chọn chỗ nào cho dễ?</summary>
        <div><b>Nên:</b> chỗ nằm sát mặt đất, thấy rõ ở cả hai ảnh: góc ngã tư, mép vỉa hè, vạch qua đường, góc sân bóng, chân một toà nhà.</div>
        <div><b>Tránh:</b> nóc nhà cao (nhìn xiên bị lệch so với ảnh vệ tinh), trời, biển, cây, xe đang chạy.</div>
        <div><b>Mẹo:</b> trên ảnh vệ tinh đã ghi sẵn tên đường; tìm con đường bạn thấy trong video theo tên. Ghim vàng là chỗ bạn đã nhập lúc nãy. Kéo ảnh để di chuyển, nút + / − để phóng.</div>
      </details>
      <div className="me-btnrow">
        <button className="btn" disabled={done < 3 || m.busy} onClick={m.points}>{done < 3 ? `Cần ít nhất 3 cặp (có ${done})` : `Khớp bản đồ với ${done} cặp`}</button>
        <button className="btn ghost small" disabled={!m.pairs.length} onClick={() => {
          const last = m.pairs[m.pairs.length - 1];
          m.setPairs(last?.m ? [...m.pairs.slice(0, -1), { f: last.f }] : m.pairs.slice(0, -1));
        }}>{p?.f && !p?.m ? "Chọn lại" : "Bỏ cặp cuối"}</button>
      </div>
      {m.doc ? <button className="btn ghost small wide" onClick={() => m.refit(true)}>Huỷ, giữ bản đồ cũ</button> : null}
      {m.doc ? <div className="dim me-small">Khớp lại chỉ đặt lại đường, vùng, toà nhà lấy từ bản đồ; các lớp bạn tự vẽ được giữ nguyên.</div> : null}
    </div>
  );
}

// ── layers and properties ────────────────────────────────────────────────────
/** a small line icon for a layer: what kind it is (a callout shows its own icon) */
function LayerIcon({ l }: { l: Layer }) {
  if (l.type === "callout") return <svg viewBox="0 0 24 24" className="fill">{CALLOUT_ICONS[l.icon].svg}</svg>;
  return (
    <svg viewBox="0 0 24 24">
      {l.type === "road" ? <path d="M4 20c3-1 4-4 6.5-7.5S16 6 20 4" />
        : l.type === "area" ? <path d="M5 8l7-4 7 5-2 10H7z" />
        : l.type === "building" || l.type === "seg" ? <><path d="M6 21V8l7-4v17M13 21V10l5 2.5V21M4 21h16" /><path d="M8.5 10h2M8.5 13.5h2M8.5 17h2" /></>
        : l.type === "pin" ? <><path d="M12 21s-6-6.2-6-11a6 6 0 0 1 12 0c0 4.8-6 11-6 11z" /><circle cx="12" cy="10" r="2" /></>
        : <path d="M6 6h12M12 6v13M9 19h6" />}
    </svg>
  );
}

const TYPE_NAME = { road: "Đường", area: "Vùng", label: "Chữ", pin: "Ghim", callout: "Tiện ích", building: "Toà nhà 3D", seg: "Toà nhà (SAM 2)" };
const layerTitle = (l: Layer) => (l.type === "road" ? l.name || (l.part ? `${l.part} (đoạn khác)` : "Đường mới") : l.type === "area" ? l.label || "Vùng" : l.type === "callout" ? l.title || "Tiện ích" : l.type === "seg" ? l.hl?.label || l.name || "Toà nhà" : l.type === "building" ? `${l.name || (l.real ? "Toà nhà có sẵn" : "Toà nhà mới")} · ${l.height} m` : l.text || TYPE_NAME[l.type]);

/** A part of the dock that folds away (remembered per browser); opened from the stepper too. */
function Section({ id, title, icon, right, open: def = true, children }: { id: string; title: string; icon: React.ReactNode; right?: React.ReactNode; open?: boolean; children: React.ReactNode }) {
  const [open, setOpen] = useState(() => { try { const v = localStorage.getItem(`sec-${id}`); return v === null ? def : v === "1"; } catch { return def; } });
  const set = (v: boolean) => { setOpen(v); try { localStorage.setItem(`sec-${id}`, v ? "1" : "0"); } catch { /* private mode */ } };
  useEffect(() => {
    const go = (e: Event) => { if ((e as CustomEvent).detail === id) { set(true); requestAnimationFrame(() => document.getElementById(`sec-${id}`)?.scrollIntoView({ behavior: "smooth", block: "start" })); } };
    addEventListener("me-open-sec", go); return () => removeEventListener("me-open-sec", go);
  });
  return (
    <section className={`me-sec ${open ? "open" : ""}`} id={`sec-${id}`}>
      <div className="me-sec-head" role="button" tabIndex={0} onClick={() => set(!open)} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); set(!open); } }}>
        <span className="me-sec-ic">{icon}</span><b>{title}</b>
        <span className="me-sec-right" onClick={(e) => e.stopPropagation()}>{right}</span>
        <span className="me-sec-chev" aria-hidden>›</span>
      </div>
      {open ? <div className="me-sec-body">{children}</div> : null}
    </section>
  );
}
const openSection = (id: string) => dispatchEvent(new CustomEvent("me-open-sec", { detail: id }));
const ico = (d: string) => <svg viewBox="0 0 24 24"><path d={d} /></svg>;
const SEC_ICONS = {
  layers: ico("M12 3 3 8l9 5 9-5zM3 13l9 5 9-5M3 17.5l9 5 9-5"),
  video: ico("M4 6h11v12H4zM15 10l5-3v10l-5-3"),
  time: ico("M12 7v5l3 2M12 21a9 9 0 1 1 0-18 9 9 0 0 1 0 18z"),
  color: ico("M12 3a9 9 0 1 0 0 18c1.5 0 2-1 2-2s-1-1.5-1-2.5S14 15 15.5 15H18a3 3 0 0 0 3-3c0-5-4-9-9-9zM7.5 11h.01M10 7h.01M15 7.5h.01"),
  claude: ico("M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8zM18 15l.9 2.1L21 18l-2.1.9L18 21l-.9-2.1L15 18l2.1-.9z"),
};

/** Where the clip stands: clip, map, drawing, colour, export; a click opens that part of the dock. */
function Stepper({ m }: { m: MapApi }) {
  const doc = m.doc!, st = m.st;
  const steps = [
    { id: "clip", name: "Clip", done: true, sec: "time" },
    { id: "map", name: "Bản đồ", done: !!st?.fit, sec: "layers" },
    { id: "draw", name: "Vẽ", done: doc.layers.length > 0, sec: "layers" },
    { id: "color", name: "Màu", done: !!(doc.grade && (doc.grade.delog && doc.grade.delog !== "none" || Object.keys(doc.grade).length > 1)) || !!doc.baked, sec: "color" },
    { id: "out", name: "Xuất", done: st?.status?.step === "done", sec: "" },
  ];
  const next = steps.find((x) => !x.done);
  return (
    <div className="me-stepper">
      {steps.map((x, i) => (
        <button key={x.id} className={`me-step ${x.done ? "done" : ""} ${x === next ? "next" : ""}`} onClick={() => (x.sec ? openSection(x.sec) : m.render())}
          title={x.sec ? `Mở phần ${x.name}` : "Xuất video"}>
          <span className="n">{x.done ? "✓" : i + 1}</span><span>{x.name}</span>
        </button>
      ))}
    </div>
  );
}

function Layers({ m, sel, setSel }: { m: MapApi; sel: string | null; setSel: (s: string | null) => void }) {
  const doc = m.doc!;
  const L = doc.layers.find((l) => l.id === sel);
  const upd = (patch: Partial<Layer>) => m.setDoc({ ...doc, layers: doc.layers.map((l) => (l.id === sel ? ({ ...l, ...patch } as Layer) : l)) });
  const [req, setReq] = useState(m.st?.request?.request ?? "");
  useEffect(() => setReq(m.st?.request?.request ?? ""), [m.name]);
  return (
    <>
      <Stepper m={m} />
      {m.st?.plan?.why ? <div className="me-note"><b>AI:</b> {m.st.plan.why}</div> : null}
      <Section id="layers" title={`Lớp (${doc.layers.length})`} icon={SEC_ICONS.layers}>
      <div className="me-layers">
        {doc.layers.map((l) => (
          <div key={l.id} className={`me-layer ${sel === l.id ? "on" : ""}`} onClick={() => setSel(l.id)}>
            <span className="me-lico" style={{ color: l.type === "road" || l.type === "area" ? l.color : undefined }}><LayerIcon l={l} /></span>
            <span className="me-ltext"><span className="me-lname">{layerTitle(l)}</span><span className="me-ltype">{TYPE_NAME[l.type]}</span></span>
            <button className={`me-eye ${l.hidden ? "off" : ""}`} title={l.hidden ? "Hiện" : "Ẩn"} onClick={(e) => { e.stopPropagation(); m.setDoc({ ...doc, layers: doc.layers.map((x) => (x.id === l.id ? { ...x, hidden: !x.hidden } : x)) }); }}>
              <svg viewBox="0 0 24 24">{l.hidden
                ? <><path d="M3 3l18 18M10.6 6.1A9.6 9.6 0 0 1 12 6c5 0 9 6 9 6a16 16 0 0 1-2.6 3.2M6.3 7.6C4.2 9.2 3 12 3 12s4 6 9 6c1.4 0 2.7-.4 3.8-1" /><path d="M9.9 10a3 3 0 0 0 4.2 4.2" /></>
                : <><path d="M3 12s4-6 9-6 9 6 9 6-4 6-9 6-9-6-9-6z" /><circle cx="12" cy="12" r="2.8" /></>}</svg>
            </button>
          </div>
        ))}
        {!doc.layers.length ? <div className="dim">Chưa có lớp nào: dùng công cụ phía trên khung hình để vẽ.</div> : null}
      </div>
      <button className="btn ghost small wide" disabled={m.busy} title="Chọn lại các cặp điểm giống nhau giữa video và ảnh vệ tinh"
        onClick={() => m.refit()}>Đường vẽ lệch? Khớp lại bản đồ</button>
      {doc.ground ? (
        <button className="btn ghost small wide" disabled={m.busy} title="Đường, vùng và chữ trên mặt đất sẽ đi ra sau các toà nhà này"
          onClick={m.occluders}>Che đường sau toà cao (từ bản đồ)</button>
      ) : null}
      {L ? (
        <div className="me-props">
          {L.type === "road" ? (<>
            <span className="dim">Tên</span><input type="text" value={L.name ?? ""} placeholder="Tên hiện trên đường" onChange={(e) => upd({ name: e.target.value })} />
            <span className="dim">Màu</span><Swatches v={L.color} on={(c) => upd({ color: c })} />
            <span className="dim">Độ dày</span>
            <div className="me-sizes">
              {LINE_SIZES.map((z) => <button key={z.w} className={`me-chipbtn ${(L.width ?? 8) === z.w ? "on" : ""}`} onClick={() => upd({ width: z.w })}>
                <i style={{ height: Math.max(2, z.w / 3) }} />{z.name}</button>)}
            </div>
            <span /><Slider v={L.width ?? 8} min={2} max={60} on={(v) => upd({ width: v })} unit=" px" />
            <span className="dim">Tốc độ</span><Slider v={L.speed ?? 1} min={0.2} max={3} step={0.1} on={(v) => upd({ speed: v })} />
            <span className="dim">Hiện lúc</span><Slider v={L.in ?? 0.4} min={0} max={docFrames(doc) / doc.fps - 0.5} step={0.1} on={(v) => upd({ in: v })} unit="s" />
          </>) : L.type === "area" ? (<>
            <span className="dim">Nhãn</span><input type="text" value={L.label ?? ""} onChange={(e) => upd({ label: e.target.value })} />
            <span className="dim">Màu</span><Swatches v={L.color} on={(c) => upd({ color: c })} />
            <span className="dim">Hiện lúc</span><Slider v={L.in ?? 1.2} min={0} max={docFrames(doc) / doc.fps - 0.5} step={0.1} on={(v) => upd({ in: v })} unit="s" />
          </>) : L.type === "building" ? (<>
            <span className="dim">Loại</span>
            <div className="me-pans">
              <button className={`me-chipbtn ${!L.real ? "on" : ""}`} onClick={() => upd({ real: false })}>Dựng toà nhà mới</button>
              <button className={`me-chipbtn ${L.real ? "on" : ""}`} onClick={() => upd({ real: true })}>Toà nhà có sẵn</button>
            </div>
            {L.real ? <><span /><span className="dim me-small">Toà nhà thật trong clip: không vẽ thêm gì, chỉ che các đường, vùng và chữ nằm phía sau nó. Vẽ chân toà nhà sát chỗ nó chạm đất, rồi kéo chiều cao tới khi khung trắng ôm sát nóc.</span></> : null}
            <span className="dim">Chiều cao</span><Slider v={L.height} min={5} max={300} step={1} unit=" m" on={(v) => upd({ height: v })} />
            <span /><span className="dim me-small">Khoảng {Math.max(1, Math.round(L.height / 3.3))} tầng</span>
            {L.real ? null : <>
            <span className="dim">Bề mặt</span>
            <div className="me-pans">{GLASS.map((g) => <button key={g.id} className={`me-chipbtn ${(L.glass ?? "blue") === g.id ? "on" : ""}`} onClick={() => upd({ glass: g.id })}>{g.name}</button>)}</div>
            <span className="dim">Mặt tiền</span>
            <FacadeImage m={m} L={L} upd={upd} />
            </>}
            <span className="dim">Làm nổi</span>
            <div className="me-pans">
              <button className={`me-chipbtn ${!L.hl ? "on" : ""}`} onClick={() => upd({ hl: undefined })}>Không</button>
              {HIGHLIGHTS.map((h) => (
                <button key={h.id} className={`me-chipbtn ${L.hl?.fx === h.id ? "on" : ""}`}
                  onClick={() => upd({ hl: { color: "#ffd166", ...L.hl, fx: h.id }, ...(L.real && !L.in ? { in: 1 } : {}) })}>{h.name}</button>
              ))}
            </div>
            {L.hl ? <>
              <span className="dim">Màu nổi</span><Swatches v={L.hl.color} on={(c) => upd({ hl: { ...L.hl!, color: c } })} />
              <span className="dim">Tên trên nóc</span><input type="text" value={L.hl.label ?? ""} placeholder={L.name || "Ví dụ: FLC SEA TOWER"} onChange={(e) => upd({ hl: { ...L.hl!, label: e.target.value || undefined } })} />
            </> : null}
            <span className="dim">Hiện lúc</span><Slider v={L.in ?? 1} min={0} max={docFrames(doc) / doc.fps - 0.5} step={0.1} on={(v) => upd({ in: v })} unit="s" />
          </>) : L.type === "seg" ? (<>
            <span className="dim">Hiệu ứng</span>
            <div className="me-pans">
              <button className={`me-chipbtn ${!L.hl ? "on" : ""}`} title="Chỉ để che đường phía sau" onClick={() => upd({ hl: null })}>Không</button>
              {HIGHLIGHTS.map((h) => <button key={h.id} className={`me-chipbtn ${L.hl?.fx === h.id ? "on" : ""}`} onClick={() => upd({ hl: { color: "#ffd166", ...L.hl, fx: h.id } })}>{h.name}</button>)}
            </div>
            {L.hl ? <>
            <span className="dim">Màu</span><Swatches v={L.hl.color} on={(c) => upd({ hl: { ...L.hl!, color: c } })} />
            <span className="dim">Tên trên nóc</span><input type="text" value={L.hl.label ?? ""} placeholder="Ví dụ: FLC SEA TOWER" onChange={(e) => upd({ hl: { ...L.hl!, label: e.target.value || undefined } })} />
            </> : null}
            <span className="dim">Xung quanh</span>
            <div className="me-pans">
              <button className={`me-chipbtn ${L.dim ? "on" : ""}`} onClick={() => upd({ dim: !L.dim })}>Làm tối xung quanh</button>
              <button className={`me-chipbtn ${L.occlude !== false ? "on" : ""}`} onClick={() => upd({ occlude: L.occlude === false })}>Đường đi ra sau toà này</button>
            </div>
            <span className="dim">Hiện lúc</span><Slider v={L.in ?? 0.6} min={0} max={docFrames(doc) / doc.fps - 0.5} step={0.1} on={(v) => upd({ in: v })} unit="s" />
            <span className="dim">Độ ổn định</span>
            <span className="dim me-small">Khớp giữa các khung thấp nhất {Math.round((L.iouMin ?? 1) * 100)}%{L.weak?.length ? `, ${L.weak.length} khung nên xem lại (từ giây ${(L.weak[0] / doc.fps).toFixed(1)})` : ", không khung nào bị nhảy"}.</span>
            <span className="dim">Kiểm tra</span>
            <div className="me-segdbg">{["first", "mid", "last"].map((tg) => (
              <a key={tg} href={`/files/output/drone/${m.name}/seg-${L.id.slice(1)}-debug-${tg}.jpg`} target="_blank" rel="noreferrer">
                <img src={`/files/output/drone/${m.name}/seg-${L.id.slice(1)}-debug-${tg}.jpg`} alt="" /></a>
            ))}</div>
          </>) : L.type === "callout" ? (
            <CalloutPanel L={L} upd={upd} max={docFrames(doc) / doc.fps - 0.5} />
          ) : (<>
            <span className="dim">Chữ</span><input type="text" value={L.text} onChange={(e) => upd({ text: e.target.value })} />
            {L.type === "label" ? <><span className="dim">Cỡ chữ</span><Slider v={L.size ?? 70} min={30} max={160} on={(v) => upd({ size: v })} /></> : null}
            <span className="dim">Hiện lúc</span><Slider v={L.in ?? 1} min={0} max={docFrames(doc) / doc.fps - 0.5} step={0.1} on={(v) => upd({ in: v })} unit="s" />
          </>)}
          <span />
          <button className="btn ghost small" onClick={() => { m.setDoc({ ...doc, layers: doc.layers.filter((l) => l.id !== sel) }); setSel(null); }}>Xoá lớp</button>
        </div>
      ) : null}

      </Section>

      <Section id="video" title="Toàn video" icon={SEC_ICONS.video}>
      <div className="me-props">
        <span className="dim">Tiêu đề</span><input type="text" value={doc.title ?? ""} placeholder="Không có" onChange={(e) => m.setDoc({ ...doc, title: e.target.value || undefined })} />
        <span className="dim">Màu phủ</span>
        <select value={doc.look} onChange={(e) => m.setDoc({ ...doc, look: e.target.value as MapDoc["look"] })}>{LOOKS.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select>
        <span className="dim">Tỉ lệ</span>
        <div className="me-ratios">
          {ASPECTS.map((a) => (
            <button key={a.id} className={`me-ratiobtn ${doc.aspect === a.id ? "on" : ""}`} title={`${a.name} · ${a.hint}`} onClick={() => m.setDoc({ ...doc, aspect: a.id })}>
              <span style={{ aspectRatio: a.id.replace(":", " / ") }} />{a.id}
            </button>
          ))}
        </div>
        <span className="dim">Phóng to</span>
        <Slider v={Math.round((doc.zoom ?? 1) * 100)} min={100} max={250} step={5} unit="%" on={(v) => m.setDoc({ ...doc, zoom: v / 100 })} />
        {canPan(doc) ? (<>
          <span className="dim">Bố cục</span>
          {doc.pan?.length ? (
            <div className="me-pans">
              {doc.pan.map((q) => (
                <span key={q.f} className="me-chipbtn on">{((q.f - trimOf(doc)[0]) / doc.fps).toFixed(1)} s
                  <b title="Bỏ điểm lia này" onClick={() => m.setDoc({ ...doc, pan: doc.pan!.filter((x) => x.f !== q.f) })}>×</b></span>
              ))}
              <button className="btn ghost small" onClick={() => m.setDoc({ ...doc, pan: undefined })}>Tự lia lại</button>
            </div>
          ) : <span className="dim me-small">Tự lia theo điểm nổi bật. Muốn tự đặt: chọn công cụ Khung (F) rồi kéo video.</span>}
        </>) : null}
      </div>

      </Section>

      <Section id="time" title="Thời lượng" icon={SEC_ICONS.time} open={false}><TrimPanel m={m} /></Section>

      <Section id="color" title="Màu clip" icon={SEC_ICONS.color} open={false}
        right={<button className="me-link" onClick={() => m.setDoc({ ...doc, grade: { delog: doc.grade?.delog } })}>Đặt lại</button>}>
        <ColorPanel m={m} />
      </Section>

      <Section id="claude" title="Nhờ AI vẽ lại" icon={SEC_ICONS.claude} open={false}>
        <textarea rows={2} value={req} onChange={(e) => setReq(e.target.value)} />
        <button className="btn ghost small wide" disabled={m.busy} onClick={() => m.redraft(req)}>Vẽ lại theo yêu cầu này</button>
        <div className="dim me-small">Vẽ lại sẽ thay các lớp hiện có.</div>
      </Section>

      {/* always in reach at the bottom of the dock */}
      <div className="me-dock-foot">
        <button className="btn wide me-go" disabled={m.busy} onClick={m.render}>Xuất video</button>
        {m.st?.status?.step === "done" && m.st.status.video ? <a className="btn ghost small wide" href={`/files/${m.st.status.video}`} download>Tải video về</a> : null}
      </div>
    </>
  );
}

const SLIDERS: { k: keyof Grade; name: string; min: number; max: number; step: number; unit?: string }[] = [
  { k: "exposure", name: "Phơi sáng", min: -2, max: 2, step: 0.05, unit: " EV" },
  { k: "contrast", name: "Tương phản", min: -100, max: 100, step: 1 },
  { k: "highlights", name: "Vùng sáng", min: -100, max: 100, step: 1 },
  { k: "shadows", name: "Vùng tối", min: -100, max: 100, step: 1 },
  { k: "saturation", name: "Bão hoà", min: -100, max: 100, step: 1 },
  { k: "temperature", name: "Nhiệt độ", min: -100, max: 100, step: 1 },
  { k: "tint", name: "Sắc độ", min: -100, max: 100, step: 1 },
];

const DELOG_EDIT: { id: Delog; name: string }[] = [
  { id: "none", name: "Không delog" }, { id: "dlogm", name: "D-Log M (LUT DJI)" }, { id: "dlog", name: "D-Log" }, { id: "hlg", name: "HLG" },
];

/** The basic sliders change the picture at once (live filter). D-Log M and a user LUT are baked into the clip, which
 *  takes a few seconds and starts by itself when they change. */
function ColorPanel({ m }: { m: MapApi }) {
  const doc = m.doc!, g = doc.grade ?? {};
  const setG = (patch: Partial<Grade>, record = true) => m.setDoc({ ...doc, grade: { ...g, ...patch } }, record);
  const [lut, setLut] = useState<string | null>(doc.baked?.lutPath ?? null);
  const [strength, setStrength] = useState(doc.baked?.strength ?? 1);
  const lutIn = useRef<HTMLInputElement>(null);
  const found = m.st?.color?.asked === "auto" ? (m.st.color.delog === "none" ? "không phải log" : DELOG_EDIT.find((d) => d.id === m.st!.color!.delog)?.name) : null;
  // bake (or drop the bake) so the clip matches delog + LUT
  const apply = (dl: Delog, l: string | null, st: number) => {
    if (dl === "dlogm" || l) m.regrade({ delog: dl, lut: l, strength: st, look: "none" }, false);
    else if (doc.baked) m.regrade({ delog: dl, lut: null, strength: 1, look: "none" }, false);
  };
  const dragging = useRef(false);
  const baking = m.busy && m.st?.status?.step === "color";
  const lutName = (p: string) => p.split("/").pop()!.replace(/^\d+-/, "");
  const delog = (g.delog ?? "none") as Delog;
  return (
    <>
      <div className="me-props">
        <span className="dim">Delog</span>
        <select value={delog} disabled={baking} onChange={(e) => { const dl = e.target.value as Delog; setG({ delog: dl }); apply(dl, lut, strength); }}>
          {DELOG_EDIT.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
        </select>
        {found ? <><span /><span className="dim me-small">Tự nhận: clip này {found}.</span></> : null}
        {baking ? <><span /><div className="me-baking"><span className="me-spin sm" />{m.st?.status?.msg}…</div></> : null}
        {SLIDERS.map((sl) => (
          <React.Fragment key={sl.k}>
            <span className="dim me-reset" title="Bấm đúp để về 0" onDoubleClick={() => setG({ [sl.k]: 0 })}>{sl.name}</span>
            <div className="row">
              <input type="range" min={sl.min} max={sl.max} step={sl.step} value={Number(g[sl.k] ?? 0)}
                onPointerDown={() => { dragging.current = false; }}
                onChange={(e) => { setG({ [sl.k]: Number(e.target.value) }, !dragging.current); dragging.current = true; }}
                onDoubleClick={() => setG({ [sl.k]: 0 })} className={`me-slider ${sl.k}`} style={fill(Number(g[sl.k] ?? 0), sl.min, sl.max)} />
              <NumField v={Number(g[sl.k] ?? 0)} min={sl.min} max={sl.max} step={sl.step} unit={sl.unit} on={(x) => setG({ [sl.k]: x })} />
            </div>
          </React.Fragment>
        ))}
      </div>

      <label className="lbl">LUT riêng (.cube)</label>
      <div className="me-props">
        <span className="dim">File</span>
        <div className="row">
          <input ref={lutIn} type="file" accept=".cube" hidden onChange={async (e) => {
            const f = e.target.files?.[0]; if (!f) return;
            const r = await fetch("/api/upload", { method: "POST", headers: { "X-Filename": f.name }, body: f }).then((x) => x.json());
            setLut(r.path); apply(delog, r.path, strength);
          }} />
          <button className="btn ghost small" disabled={baking} onClick={() => lutIn.current?.click()}>{lut ? lutName(lut) : "Chọn .cube"}</button>
          {lut ? <button className="btn ghost small" disabled={baking} onClick={() => { setLut(null); apply(delog, null, 1); }}>Bỏ</button> : null}
        </div>
        {lut ? <><span className="dim">Độ mạnh</span>
          <div className="row"><input type="range" min={0} max={100} value={Math.round(strength * 100)} disabled={baking} style={fill(strength * 100, 0, 100)}
            onChange={(e) => setStrength(Number(e.target.value) / 100)}
            onPointerUp={(e) => apply(delog, lut, Number((e.target as HTMLInputElement).value) / 100)} />
            <NumField v={Math.round(strength * 100)} min={0} max={100} unit="%" digits={0} disabled={baking} on={(x) => { setStrength(x / 100); apply(delog, lut, x / 100); }} /></div></> : null}
      </div>
      <div className="dim me-small">D-Log M và LUT được nướng vào clip trong vài giây, bản xuất nướng lại từ file gốc 10-bit. Bật “Trước / sau” để so.</div>
    </>
  );
}

const Swatches = ({ v, on }: { v: string; on: (c: string) => void }) => (
  <div className="me-sw">{COLORS.map((c) => <button key={c} className={v === c ? "on" : ""} style={{ background: c }} onClick={() => on(c)} />)}
    <input type="color" value={v} onChange={(e) => on(e.target.value)} title="Màu khác" /></div>
);
/** whether the clip is bigger than the output (a different ratio, or zoomed in), so there is a framing to choose */
const canPan = (doc: MapDoc) => {
  const { W, H } = outSize(doc.aspect), k = Math.max(W / doc.srcW, H / doc.srcH) * Math.max(1, doc.zoom ?? 1);
  return doc.srcW * k > W + 1 || doc.srcH * k > H + 1;
};

/**
 * The facade of a building: an image put on its front wall (or every wall). The four corners mark the part of the image
 * that is the facade, so a perspective render of the project can be used too, not only a flat elevation.
 */
function FacadeImage({ m, L, upd }: { m: MapApi; L: BuildingLayer; upd: (p: Partial<Layer>) => void }) {
  const pick = useRef<HTMLInputElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState(false), [err, setErr] = useState("");
  const q = L.imgQuad ?? [[0, 0], [1, 0], [1, 1], [0, 1]];
  const load = async (f: File) => {
    setBusy(true); setErr("");
    try {
      const r = await fetch(`/api/map/${m.name}/asset`, { method: "POST", headers: { "X-Filename": f.name }, body: f }).then((x) => x.json());
      if (!r.path) throw new Error(r.error ?? "Không tải lên được");
      const im = new Image();
      im.src = `/${r.path}`;
      await im.decode();
      upd({ image: r.path, imgW: im.naturalWidth, imgH: im.naturalHeight, imgQuad: undefined });
    } catch (e) { setErr((e as Error).message); }
    setBusy(false);
  };
  const drag = (i: number) => (e: React.PointerEvent) => {
    e.preventDefault(); e.stopPropagation();
    const r = box.current!.getBoundingClientRect();
    let last = q;
    const mv = (ev: PointerEvent) => {
      const p: Pt = [Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (ev.clientY - r.top) / r.height))];
      last = q.map((c, j) => (j === i ? [Number(p[0].toFixed(4)), Number(p[1].toFixed(4))] : c)) as Pt[];
      upd({ imgQuad: last });
    };
    const up = () => { removeEventListener("pointermove", mv); removeEventListener("pointerup", up); };
    addEventListener("pointermove", mv); addEventListener("pointerup", up);
  };
  return (
    <div className="me-facade">
      <input ref={pick} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) load(f); e.target.value = ""; }} />
      {L.image ? (
        <>
          <div className="me-facade-img" ref={box}>
            <img src={`/${L.image}`} alt="" draggable={false} />
            <svg viewBox="0 0 1 1" preserveAspectRatio="none"><polygon points={q.map((p) => p.join(",")).join(" ")} /></svg>
            {q.map((p, i) => <span key={i} className="me-facade-h" style={{ left: `${p[0] * 100}%`, top: `${p[1] * 100}%` }} onPointerDown={drag(i)} />)}
          </div>
          <div className="dim me-small">Kéo 4 góc vàng ôm đúng mặt tiền trong ảnh (trên trái, trên phải, dưới phải, dưới trái).</div>
          <div className="me-pans">
            <button className={`me-chipbtn ${!L.wrap ? "on" : ""}`} onClick={() => upd({ wrap: false })}>Mặt chính</button>
            <button className={`me-chipbtn ${L.wrap ? "on" : ""}`} onClick={() => upd({ wrap: true })}>Mọi mặt</button>
            {!L.wrap ? <button className="me-chipbtn" title="Dán ảnh sang mặt tường kế bên" onClick={() => upd({ front: ((L.front ?? 0) + 1) % L.pts.length })}>Đổi mặt</button> : null}
          </div>
          <div className="me-btnrow">
            <button className="btn ghost small" disabled={busy} onClick={() => pick.current?.click()}>Ảnh khác</button>
            <button className="btn ghost small" onClick={() => upd({ image: undefined, imgW: undefined, imgH: undefined, imgQuad: undefined })}>Bỏ ảnh</button>
          </div>
        </>
      ) : (
        <button className="btn ghost small" disabled={busy} onClick={() => pick.current?.click()}>{busy ? "Đang tải ảnh…" : "Chọn ảnh toà nhà"}</button>
      )}
      {err ? <div className="err">{err}</div> : null}
    </div>
  );
}

/** short lines buyers care about, one click to use */
const CALLOUT_SUBS = ["Chỉ 2 phút đi bộ", "Cách 500 m", "Ngay mặt tiền", "Mở cửa 24/7", "Đang mở bán", "Tầm nhìn ra biển"];

/**
 * The amenity badge, laid out in the order you decide it: what it looks like (a live preview), what kind of place it is,
 * its two lines of text, when it appears.
 */
function CalloutPanel({ L, upd, max }: { L: Extract<Layer, { type: "callout" }>; upd: (p: Partial<Layer>) => void; max: number }) {
  return (
    <div className="me-callpanel">
      <div className="me-callprev" aria-hidden>
        <div style={{ position: "absolute", left: "50%", bottom: 8, transform: "scale(0.52)", transformOrigin: "50% 100%" }}>
          <div style={{ position: "relative", width: 0, height: 0, left: -150 }}>
            <Callout title={L.title || " "} sub={L.sub} icon={L.icon} p={[0, 0]} t={10} at={0} />
          </div>
        </div>
      </div>
      <div className="me-field"><span>Loại tiện ích</span>
        <div className="me-kinds">
          {(Object.keys(CALLOUT_ICONS) as CalloutIcon[]).map((k) => (
            <button key={k} className={`me-kind ${L.icon === k ? "on" : ""}`}
              // a title still left at the old kind's name follows the new kind
              onClick={() => upd({ icon: k, ...(L.title === CALLOUT_ICONS[L.icon].name ? { title: CALLOUT_ICONS[k].name } : {}) })}>
              <svg viewBox="0 0 24 24" fill="currentColor" color="currentColor">{CALLOUT_ICONS[k].svg}</svg><span>{CALLOUT_ICONS[k].name}</span>
            </button>
          ))}
        </div>
      </div>
      <label className="me-field"><span>Tiêu đề</span><input type="text" value={L.title} placeholder="Ví dụ: Trường học" onChange={(e) => upd({ title: e.target.value })} /></label>
      <label className="me-field"><span>Dòng phụ</span><input type="text" value={L.sub ?? ""} placeholder="Ví dụ: chỉ 2 phút đi bộ" onChange={(e) => upd({ sub: e.target.value || undefined })} /></label>
      <div className="me-subs">{CALLOUT_SUBS.map((x) => <button key={x} className={`me-chipbtn ${L.sub === x ? "on" : ""}`} onClick={() => upd({ sub: x })}>{x}</button>)}</div>
      <div className="me-field"><span>Hiện lúc</span><Slider v={L.in ?? 1} min={0} max={max} step={0.1} on={(v) => upd({ in: v })} unit="s" /></div>
    </div>
  );
}

/**
 * Which part of the clip the video uses. Inside the stretch already cut it is a trim (at once); outside it, the stretch
 * is cut and tracked again on the server and the layers are carried over.
 */
function TrimPanel({ m }: { m: MapApi }) {
  const doc = m.doc!, meta = m.st?.meta;
  const s0 = meta?.start ?? 0, d0 = meta?.dur ?? doc.H.length / doc.fps, D = Math.max(s0 + d0, meta?.clipDur ?? 0);
  const [a0, b0] = trimOf(doc), cur: [number, number] = [s0 + a0 / doc.fps, s0 + b0 / doc.fps];
  const [sel, setSel] = useState<[number, number]>(cur);
  const [thumbs, setThumbs] = useState<string[]>([]);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => setSel(cur), [cur[0], cur[1]]);
  useEffect(() => {
    if (!meta?.clip) return;
    post("/api/map/thumbs", { clip: meta.clip }).then((r) => setThumbs(r.thumbs ?? [])).catch(() => undefined);
  }, [meta?.clip]);
  if (!meta) return null;
  const r1 = (x: number) => Math.round(x * 10) / 10;
  const inside = (p: [number, number]) => p[0] >= s0 - 0.01 && p[1] <= s0 + d0 + 0.01;
  // a new range: a trim when it fits in the cut, else it waits for "Cắt lại"
  const put = (p: [number, number]) => {
    let [a, b] = p;
    a = Math.max(0, Math.min(D - 1, a)); b = Math.max(a + 1, Math.min(D, a + 30, b));
    const q: [number, number] = [r1(a), r1(b)];
    setSel(q);
    if (inside(q)) {
      const t: [number, number] = [Math.round((q[0] - s0) * doc.fps), Math.min(doc.H.length, Math.round((q[1] - s0) * doc.fps))];
      m.setDoc({ ...doc, trim: t[0] === 0 && t[1] >= doc.H.length ? undefined : t });
    }
  };
  const drag = (kind: "a" | "b" | "move") => (e: React.PointerEvent) => {
    e.preventDefault(); e.stopPropagation();
    const r = box.current!.getBoundingClientRect(), x0 = e.clientX, [a, b] = sel;
    let last = sel;
    const mv = (ev: PointerEvent) => {
      const dt = ((ev.clientX - x0) / r.width) * D;
      last = kind === "a" ? [Math.min(b - 1, a + dt), b] : kind === "b" ? [a, Math.max(a + 1, b + dt)] : [Math.max(0, Math.min(D - (b - a), a + dt)), Math.max(0, Math.min(D - (b - a), a + dt)) + (b - a)];
      setSel([r1(last[0]), r1(last[1])]);
    };
    const up = () => { removeEventListener("pointermove", mv); removeEventListener("pointerup", up); put(last); };
    addEventListener("pointermove", mv); addEventListener("pointerup", up);
  };
  const pc = (x: number) => `${(x / D) * 100}%`;
  const out = !inside(sel);
  return (
    <>
      <div className="me-trim">
        <div className="me-trimstrip" ref={box}>
          {thumbs.map((t) => <img key={t} src={t} alt="" draggable={false} />)}
          <div className="me-trimcut" style={{ left: pc(s0), width: pc(d0) }} title="Phần đã cắt và bám" />
          <div className={`me-trimsel ${out ? "out" : ""}`} style={{ left: pc(sel[0]), width: pc(sel[1] - sel[0]) }} onPointerDown={drag("move")}>
            <span className="h a" onPointerDown={drag("a")} /><span className="h b" onPointerDown={drag("b")} />
          </div>
        </div>
        <div className="me-trimfields">
          <div><span className="dim">Bắt đầu</span><NumField v={sel[0]} min={0} max={D - 1} step={0.1} digits={1} unit=" s" on={(x) => put([x, x + (sel[1] - sel[0])])} /></div>
          <div><span className="dim">Kết thúc</span><NumField v={sel[1]} min={1} max={D} step={0.1} digits={1} unit=" s" on={(x) => put([sel[0], x])} /></div>
          <div><span className="dim">Độ dài</span><span className="me-trimlen">{(sel[1] - sel[0]).toFixed(1)} s</span></div>
        </div>
        <div className="dim me-small">Kéo hai đầu khung vàng hoặc gõ số giây. Clip dài {mmss(D)}; khung chấm là phần đã bám chuyển động.</div>
        {out ? (
          <div className="me-note">
            Đoạn mới ra ngoài phần đã cắt ({s0.toFixed(1)}–{(s0 + d0).toFixed(1)} s): cần cắt lại và bám chuyển động lại, mất khoảng nửa phút.
            Các lớp đã vẽ được giữ và dời theo.
            <div className="me-btnrow" style={{ marginTop: 8 }}>
              <button className="btn small" disabled={m.busy} onClick={() => m.recut(sel[0], r1(sel[1] - sel[0]))}>Cắt lại đoạn này</button>
              <button className="btn ghost small" onClick={() => setSel(cur)}>Huỷ</button>
            </div>
          </div>
        ) : null}
      </div>
    </>
  );
}

/** the gold part of a slider's track: from 0 (or the left end) to the value */
const fill = (v: number, min: number, max: number) => {
  const pc = (x: number) => ((Math.min(max, Math.max(min, x)) - min) / (max - min || 1)) * 100;
  const z = pc(min < 0 && max > 0 ? 0 : min), p = pc(v);
  return { "--a": `${Math.min(z, p)}%`, "--b": `${Math.max(z, p)}%` } as React.CSSProperties;
};
/** a slider's value as a field you can type into: Enter or leaving it applies (clamped to the slider's range, a comma
 *  works as the decimal point), Esc goes back, ↑ / ↓ step (with Shift, ten steps) */
function NumField({ v, min, max, step = 1, on, unit = "", digits = 2, disabled }: { v: number; min: number; max: number; step?: number; on: (v: number) => void; unit?: string; digits?: number; disabled?: boolean }) {
  const show = String(Number(v.toFixed(digits)));
  const [draft, setDraft] = useState<string | null>(null);
  const put = (x: number) => { const q = Math.min(max, Math.max(min, Math.round(x / step) * step)); on(Number(q.toFixed(digits))); };
  const apply = () => { if (draft !== null) { const x = Number(draft.replace(",", ".").trim()); if (draft.trim() !== "" && Number.isFinite(x)) put(x); setDraft(null); } };
  return (
    <label className={`me-numfield ${disabled ? "off" : ""}`} title={`Gõ số từ ${min} đến ${max}`}>
      <input type="text" inputMode="decimal" value={draft ?? show} disabled={disabled} size={Math.max(2, (draft ?? show).length)}
        onFocus={(e) => { setDraft(show); requestAnimationFrame(() => e.target.select()); }}
        onChange={(e) => setDraft(e.target.value)} onBlur={apply}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          else if (e.key === "Escape") { setDraft(null); requestAnimationFrame(() => (e.target as HTMLInputElement).blur()); }
          else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
            e.preventDefault();
            const cur = Number((draft ?? show).replace(",", ".")) || 0, nx = cur + (e.key === "ArrowUp" ? 1 : -1) * step * (e.shiftKey ? 10 : 1);
            put(nx); setDraft(String(Number(Math.min(max, Math.max(min, nx)).toFixed(digits))));
          }
        }} />
      {unit ? <span>{unit.trim()}</span> : null}
    </label>
  );
}
const Slider = ({ v, min, max, step = 1, on, unit = "" }: { v: number; min: number; max: number; step?: number; on: (v: number) => void; unit?: string }) => (
  <div className="row"><input type="range" min={min} max={max} step={step} value={v} style={fill(v, min, max)} onChange={(e) => on(Number(e.target.value))} /><NumField v={v} min={min} max={max} step={step} on={on} unit={unit} digits={1} /></div>
);

// ── the stage ────────────────────────────────────────────────────────────────
export function MapStage(props: { m: MapApi; sel: string | null; setSel: (s: string | null) => void }) {
  return <><StageView {...props} /><JobModal m={props.m} /></>;
}

/**
 * While a job runs nothing else can be changed: a window over the whole studio says what is happening, its stages
 * (done, going, waiting), how far the current one is when the server knows (cutting, tracking, baking, rendering) and how
 * long it has taken. It ends on a short "done" (a render keeps its download button) or on the error, until closed.
 */
function JobModal({ m }: { m: MapApi }) {
  const s = m.st?.status, step = s?.step ?? "";
  const [now, setNow] = useState(Date.now());
  const [end, setEnd] = useState<null | { ok: boolean; title: string; msg?: string; video?: string }>(null);
  const was = useRef<{ busy: boolean; title: string }>({ busy: false, title: "" });
  const title = s?.job ?? STEP_LABEL[step] ?? "Đang xử lý";
  useEffect(() => { if (!m.busy) return; const t = setInterval(() => setNow(Date.now()), 500); return () => clearInterval(t); }, [m.busy]);
  useEffect(() => {
    if (m.busy) { was.current = { busy: true, title }; setEnd(null); return; }
    if (!was.current.busy) return;
    was.current.busy = false;
    if (step === "error") setEnd({ ok: false, title: was.current.title, msg: s?.msg });
    else if (step === "done" || step === "ready") {
      setEnd({ ok: true, title: was.current.title, msg: s?.msg, video: step === "done" ? s?.video : undefined });
      if (step === "ready") { const t = setTimeout(() => setEnd(null), 2200); return () => clearTimeout(t); }
    }
  }, [m.busy, step]);
  if (!m.busy && !end) return null;
  if (end) return (
    <div className="me-modal-back">
      <div className={`me-modal ${end.ok ? "ok" : "bad"}`}>
        <div className="me-modal-mark">{end.ok ? "✓" : "!"}</div>
        <b className="me-modal-title">{end.ok ? `${end.title}: xong` : `${end.title}: có lỗi`}</b>
        {end.msg ? <div className={end.ok ? "dim" : "me-modal-err"}>{end.msg}</div> : null}
        <div className="me-btnrow">
          {end.video ? <a className="btn" href={`/files/${end.video}`} download>Tải video về</a> : null}
          <button className={`btn ${end.video ? "ghost" : ""}`} onClick={() => setEnd(null)}>{end.ok ? "Đóng" : "Đóng và sửa tiếp"}</button>
        </div>
      </div>
    </div>
  );
  const stages = s?.stages?.length ? s.stages : [STEP_LABEL[step] ?? s?.msg ?? "Đang xử lý"];
  const cur = Math.min(stages.length - 1, Math.max(0, s?.stage ?? 0)), pct = s?.pct;
  const overall = Math.round(((cur + (pct ?? 0)) / stages.length) * 100);
  const secs = s?.started ? Math.max(0, now / 1000 - s.started) : 0;
  return (
    <div className="me-modal-back">
      <div className="me-modal" role="dialog" aria-live="polite">
        <div className="me-modal-head">
          <span className="me-spin" />
          <div><b className="me-modal-title">{title}</b><div className="dim">{secs ? `Đã chạy ${mmss(secs)}` : "Đang bắt đầu…"}</div></div>
          <span className="me-modal-pct">{overall}%</span>
        </div>
        <div className="me-modal-bar"><div style={{ width: `${overall}%` }} /></div>
        <ol className="me-modal-steps">
          {stages.map((lb, i) => (
            <li key={i} className={i < cur ? "done" : i === cur ? "on" : ""}>
              <span className="ic">{i < cur ? "✓" : i + 1}</span>
              <div>
                <span>{lb}</span>
                {i === cur ? (
                  <>
                    <div className={`me-modal-sub ${pct === undefined ? "indet" : ""}`}><div style={pct === undefined ? undefined : { width: `${Math.round(pct * 100)}%` }} /></div>
                    {s?.msg && s.msg !== lb ? <div className="dim me-small">{s.msg}{pct !== undefined ? ` · ${Math.round(pct * 100)}%` : ""}</div> : null}
                  </>
                ) : null}
              </div>
            </li>
          ))}
        </ol>
        <div className="me-modal-note">Trong lúc này chưa sửa được phần khác. Cửa sổ tự đóng khi xong.</div>
      </div>
    </div>
  );
}

function StageView({ m, sel, setSel }: { m: MapApi; sel: string | null; setSel: (s: string | null) => void }) {
  const st = m.st, step = st?.status?.step ?? "";
  if (m.fresh || !m.name) return <Intro />;
  if (step === "need-points" && st?.meta?.tiles) return <PointsStage m={m} />;
  if (!m.doc) return (
    <div className="stage-empty me-intro">
      {m.busy ? <span className="me-spin" /> : null}
      <b>{m.busy ? STEP_LABEL[step] ?? "Đang chạy…" : step === "need-place" ? "Cho biết nơi quay ở bên trái" : step === "error" ? "Có lỗi, xem bên trái" : ""}</b>
      {m.busy ? <span>Bản nháp hiện ở đây khi xong. Thường mất 1 đến 3 phút.</span> : null}
    </div>
  );
  return <Editor m={m} sel={sel} setSel={setSel} />;
}

const Intro = () => (
  <div className="stage-empty me-intro">
    <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth={1.6}><path d="M3 6l6-3 6 3 6-3v15l-6 3-6-3-6 3z" /><path d="M9 3v15M15 6v15" /></svg>
    <b>Đường, tên đường và công trình trên clip flycam</b>
    <span>Đưa clip và viết bạn muốn vẽ gì. AI vẽ nháp bám theo mặt đất, bạn sửa trực tiếp trên khung hình rồi xuất video.</span>
  </div>
);

/** satellite mosaic pixel ↔ lat/lon (Web Mercator tiles, as drone-map.py fetched them) */
function satToLL(st: State, px: number, py: number): [number, number] {
  const z = st.meta!.zoom ?? 18, [tx, ty] = st.meta!.tiles!, n = 2 ** z;
  const X = tx + px / 256, Y = ty + py / 256;
  return [(Math.atan(Math.sinh(Math.PI * (1 - (2 * Y) / n))) * 180) / Math.PI, (X / n) * 360 - 180];
}
function llToSat(st: State, lat: number, lon: number): Pt {
  const z = st.meta!.zoom ?? 18, [tx, ty] = st.meta!.tiles!, n = 2 ** z;
  return [((lon + 180) / 360 * n - tx) * 256, ((1 - Math.asinh(Math.tan((lat * Math.PI) / 180)) / Math.PI) / 2 * n - ty) * 256];
}

function PointsStage({ m }: { m: MapApi }) {
  const st = m.st!;
  const [zoom, setZoom] = useState(0.6);
  const [roads, setRoads] = useState<{ name: string; pts: Pt[] }[]>([]);
  const satBox = useRef<HTMLDivElement>(null);
  const centre = st.meta?.center ? llToSat(st, st.meta.center[0], st.meta.center[1]) : null;
  // the satellite opens on the place the user gave
  useEffect(() => {
    const el = satBox.current; if (!el || !centre) return;
    el.scrollLeft = centre[0] * zoom - el.clientWidth / 2; el.scrollTop = centre[1] * zoom - el.clientHeight / 2;
  }, [st.meta?.tiles?.[0]]);
  // street names on the satellite, from the map data already fetched for the clip
  useEffect(() => {
    fetch(`/files/output/drone/${m.name}/osm.json`).then((r) => r.json()).then((osm) => {
      const out: { name: string; pts: Pt[] }[] = [];
      for (const e of osm.elements ?? []) {
        const t = e.tags ?? {};
        if (e.type !== "way" || !t.highway || !t.name || ["footway", "path", "steps", "cycleway", "service"].includes(t.highway) || !e.geometry) continue;
        out.push({ name: t.name, pts: e.geometry.map((g: { lat: number; lon: number }) => llToSat(st, g.lat, g.lon)) });
      }
      setRoads(out);
    }).catch(() => undefined);
  }, [m.name]);
  // one name per street and stretch: a street is many map pieces, and a name every few metres is noise
  const labels = useMemo(() => {
    const out: { name: string; x: number; y: number; ang: number }[] = [];
    const gap = 260 / zoom;
    for (const r of [...roads].sort((a, b) => b.pts.length - a.pts.length)) {
      const j = Math.max(0, Math.floor(r.pts.length / 2) - 1), a = r.pts[j], b = r.pts[Math.min(r.pts.length - 1, j + 1)];
      const x = (a[0] + b[0]) / 2, y = (a[1] + b[1]) / 2;
      if (out.some((o) => (o.name === r.name && Math.hypot(o.x - x, o.y - y) < gap * 2) || Math.hypot(o.x - x, o.y - y) < gap / 3)) continue;
      let ang = (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI; if (ang > 90) ang -= 180; if (ang < -90) ang += 180;
      out.push({ name: r.name, x, y, ang });
    }
    return out;
  }, [roads, zoom]);
  const W = st.meta!.w, H = st.meta!.h;
  const cur = m.pairs.findIndex((p) => !p.f || !p.m), k = cur < 0 ? m.pairs.length : cur;
  const wantMap = !!m.pairs[k]?.f, full = k >= 5;
  const onFrame = (e: React.MouseEvent<HTMLDivElement>) => {
    if (wantMap || full) return;
    const r = e.currentTarget.getBoundingClientRect();
    const ps = [...m.pairs]; ps[k] = { f: [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height] }; m.setPairs(ps);
  };
  // the satellite: drag to move around, a click (no drag) places the point
  const satDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const el = satBox.current!, x0 = e.clientX, y0 = e.clientY, sl = el.scrollLeft, stp = el.scrollTop;
    let moved = false;
    const mv = (ev: PointerEvent) => {
      if (Math.hypot(ev.clientX - x0, ev.clientY - y0) > 4) moved = true;
      if (moved) { el.scrollLeft = sl - (ev.clientX - x0); el.scrollTop = stp - (ev.clientY - y0); }
    };
    const up = (ev: PointerEvent) => {
      removeEventListener("pointermove", mv); removeEventListener("pointerup", up);
      if (moved || !wantMap) return;
      const img = el.querySelector("img")!.getBoundingClientRect();
      const ps = [...m.pairs]; ps[k] = { ...ps[k], m: satToLL(st, (ev.clientX - img.left) / zoom, (ev.clientY - img.top) / zoom) }; m.setPairs(ps);
    };
    addEventListener("pointermove", mv); addEventListener("pointerup", up);
  };
  const zoomBy = (f: number) => {
    const el = satBox.current!, cx = (el.scrollLeft + el.clientWidth / 2) / zoom, cy = (el.scrollTop + el.clientHeight / 2) / zoom;
    const z = Math.min(2.5, Math.max(0.2, zoom * f));
    setZoom(z);
    requestAnimationFrame(() => { el.scrollLeft = cx * z - el.clientWidth / 2; el.scrollTop = cy * z - el.clientHeight / 2; });
  };
  const col = PAIR_COLORS[Math.min(k, 4)];
  return (
    <div className="drone-stage-body">
      <div className="me-pane">
        <div className={`me-pane-head ${!wantMap && !full ? "on" : ""}`}><span className="me-stepno">1</span>{full ? "Đủ điểm" : wantMap ? "Đã chọn trên video" : <>Bấm một chỗ trên video <span className="dim">({PAIR_WHERE[k]})</span></>}</div>
        <div className={`drone-frame ${wantMap || full ? "wait" : "want"}`} onClick={onFrame} style={{ aspectRatio: `${W} / ${H}`, ["--pair" as string]: col }}>
          <img src={`/files/output/drone/${m.name}/frame.jpg?v=${m.name}`} alt="" draggable={false} />
          <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
            {m.pairs.map((p, i) => (p.f ? <Marker key={i} x={p.f[0] * W} y={p.f[1] * H} n={i + 1} s={W / 960} c={PAIR_COLORS[i]} pulse={i === k} /> : null))}
          </svg>
        </div>
      </div>
      <div className="me-pane">
        <div className={`me-pane-head ${wantMap ? "on" : ""}`}><span className="me-stepno">2</span>{wantMap ? <>Bấm <b style={{ color: col }}>đúng chỗ số {k + 1}</b> trên ảnh vệ tinh</> : "Rồi bấm chỗ đó trên ảnh vệ tinh"}
          <span className="me-zoom"><button className="btn ghost small" onClick={() => zoomBy(1.4)}>+</button><button className="btn ghost small" onClick={() => zoomBy(1 / 1.4)}>−</button></span>
        </div>
        <div className={`drone-sat-box ${wantMap ? "want" : ""}`} ref={satBox} onPointerDown={satDown}>
          <div style={{ position: "relative", width: 256 * (st.meta!.tilesAcross ?? 11) * zoom }}>
            <img src={`/files/output/drone/${m.name}/sat.jpg`} alt="" draggable={false} style={{ width: "100%", display: "block" }} />
            <svg style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none", overflow: "visible" }}>
              {roads.map((r, i) => <polyline key={i} points={r.pts.map(([x, y]) => `${x * zoom},${y * zoom}`).join(" ")} className="me-satroad" />)}
              {labels.map((l, i) => <text key={`t${i}`} x={l.x * zoom} y={l.y * zoom} transform={`rotate(${l.ang} ${l.x * zoom} ${l.y * zoom})`} className="me-satname">{l.name}</text>)}
              {centre ? <g transform={`translate(${centre[0] * zoom} ${centre[1] * zoom})`}><path d="M0 0 C-7 -10 -10 -14 -10 -20 a10 10 0 0 1 20 0 c0 6 -3 10 -10 20z" fill="#d6b36a" stroke="#000" strokeWidth={1.5} /><circle cy={-20} r={3.5} fill="#000" /></g> : null}
              {m.pairs.map((p, i) => { if (!p.m) return null; const [x, y] = llToSat(st, ...p.m); return <Marker key={i} x={x * zoom} y={y * zoom} n={i + 1} s={1} c={PAIR_COLORS[i]} />; })}
            </svg>
          </div>
        </div>
      </div>
    </div>
  );
}

const Marker = ({ x, y, n, s, c = "#ff8a3d", pulse }: { x: number; y: number; n: number; s: number; c?: string; pulse?: boolean }) => (
  <g transform={`translate(${x} ${y}) scale(${s})`}>
    {pulse ? <circle r={13} fill="none" stroke={c} strokeWidth={3} className="me-pulse" /> : null}
    <circle r={13} fill={c} stroke="#fff" strokeWidth={3} />
    <text y={5} textAnchor="middle" fontSize={14} fontWeight={800} fill="#fff">{n}</text>
  </g>
);

const TOOL_ICONS: Record<Tool, string> = {
  select: "M5 3l13 7-6 1.5L9 18z", road: "M4 20c3-1 4-4 6.5-7.5S16 6 20 4", area: "M5 8l7-4 7 5-2 10H7z", building: "M6 21V8l7-4v17M13 21V10l5 2.5V21M4 21h16",
  seg: "M4 20 14 10M15 4v3M18.5 5.5l-2 2M20 9h-3M12 3v2", label: "M6 6h12M12 6v13M9 19h6", pin: "M12 21s-6-6.2-6-11a6 6 0 0 1 12 0c0 4.8-6 11-6 11z",
  callout: "M12 3l2.5 5 5.5.8-4 3.9 1 5.5L12 15.6 7 18.2l1-5.5-4-3.9 5.5-.8z", frame: "M7 3v14h14M3 7h14v14",
};
/** where a gap goes in the toolbar: drawing on the ground, buildings, framing */
const TOOL_GROUP: Record<Tool, number> = { select: 0, road: 1, area: 1, label: 1, pin: 1, callout: 1, building: 2, seg: 2, frame: 3 };
const TOOLS: { id: Tool; name: string; hint: string; key: string }[] = [
  { id: "select", name: "Chọn", hint: "Bấm một lớp để chọn, kéo điểm tròn để sửa, kéo cả lớp để dời", key: "V" },
  { id: "road", name: "Vẽ đường", hint: "Bấm từng điểm dọc con đường, bấm đúp hoặc Enter để xong", key: "L" },
  { id: "area", name: "Vẽ vùng", hint: "Bấm các góc của công trình, bấm đúp hoặc Enter để xong", key: "A" },
  { id: "building", name: "Toà nhà", hint: "Bấm các góc chân toà nhà trên mặt đất, bấm đúp hoặc Enter để xong; chỉnh chiều cao và ảnh mặt tiền ở cột trái", key: "B" },
  { id: "seg", name: "Tách toà nhà", hint: "Bấm vào giữa từng toà nhà thật (toà cần làm nổi, các toà che đường), rồi bấm \"Lần theo\": SAM 2 tách đúng hình dáng qua cả clip", key: "S" },
  { id: "label", name: "Chữ", hint: "Bấm chỗ đặt chữ nằm trên mặt đất", key: "T" },
  { id: "pin", name: "Ghim", hint: "Bấm chỗ cắm ghim địa điểm", key: "P" },
  { id: "callout", name: "Tiện ích", hint: "Bấm đúng chỗ của tiện ích (trường, bệnh viện, chợ…), rồi chọn biểu tượng và sửa chữ ở cột trái", key: "U" },
  { id: "frame", name: "Khung", hint: "Kéo video để đặt bố cục ở giây đang xem, lăn chuột để phóng to; đặt ở vài giây khác nhau thì khung lia giữa các chỗ đó", key: "F" },
];

function Editor({ m, sel, setSel }: { m: MapApi; sel: string | null; setSel: (s: string | null) => void }) {
  const doc = m.doc!;
  const player = useRef<PlayerRef>(null);
  const [frame, setFrame] = useState(0), [playing, setPlaying] = useState(false);
  const tick = useRef<(f: number) => void>(() => undefined);   // the transport's own frame
  const [tool, setTool] = useState<Tool>("select");
  const [draft, setDraft] = useState<Pt[]>([]);           // points of the line / area being drawn (first-frame fractions)
  // buildings clicked for SAM 2, not sent yet: the frame they were clicked on, the clicks (fractions of the tracked frame)
  const [segPick, setSegPick] = useState<{ f: number; pts: Pt[]; hl: boolean } | null>(null);
  const [hover, setHover] = useState<{ style?: LineStyle; nameStyle?: NameStyle } | null>(null);
  const [all, setAll] = useState(false);
  const [mouse, setMouse] = useState<Pt | null>(null);
  const [split, setSplit] = useState<number | null>(null);
  const { W: OW, H: OH } = outSize(doc.aspect);
  // what plays: the document, or the style under the mouse on the selected road (or all roads)
  const shown = useMemo(() => {
    if (!hover) return doc;
    return { ...doc, layers: doc.layers.map((l) => (l.type === "road" && (all || l.id === sel || !sel) ? { ...l, ...(hover.style ? { style: hover.style } : {}), ...(hover.nameStyle ? { nameStyle: hover.nameStyle } : {}) } : l)) };
  }, [doc, hover, sel, all]);
  const P = useProjection(doc);
  const cams = useCameras(doc, P);
  const segs = useSegs(doc.layers.filter((l) => l.type === "seg").map((l) => (l as Extract<Layer, { type: "seg" }>).src), false);
  useEffect(() => {
    const p = player.current; if (!p) return;
    // while playing only the transport follows the frame: re-rendering the editor every frame makes the player
    // miss ticks and fall behind the video, which then jumps back
    const f = (e: { detail: { frame: number } }) => { tick.current(e.detail.frame); if (!p.isPlaying()) setFrame(e.detail.frame); };
    const on = () => setPlaying(true), off = () => { setPlaying(false); setFrame(p.getCurrentFrame()); };
    p.addEventListener("frameupdate", f); p.addEventListener("play", on); p.addEventListener("pause", off);
    const f0 = Math.min(docFrames(doc) - 1, Math.round(doc.fps * 3));
    p.seekTo(f0); setFrame(f0);
    return () => { p.removeEventListener("frameupdate", f); p.removeEventListener("play", on); p.removeEventListener("pause", off); };
  }, [m.name, doc.aspect, doc.trim?.[0], doc.trim?.[1]]);
  const finish = () => {
    if (tool === "road" && draft.length >= 2) add({ id: `u${uid()}`, type: "road", pts: draft, style: "glow", color: COLORS[doc.layers.length % COLORS.length], width: 8, speed: 1, in: 0.4, name: "", nameStyle: "along" });
    if (tool === "area" && draft.length >= 3) add({ id: `u${uid()}`, type: "area", pts: draft, label: "KHU VỰC", color: "#ffb02e", in: 1.2 });
    if (tool === "building" && draft.length >= 3) add({ id: `u${uid()}`, type: "building", pts: draft, height: 60, glass: "blue", in: 1 });
    setDraft([]);
  };
  const add = (l: Layer) => { m.setDoc({ ...doc, layers: [...doc.layers, l] }); setSel(l.id); setTool("select"); };
  // keyboard: tools, delete, undo, finish, play
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest("input, textarea, select")) return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") { e.preventDefault(); e.shiftKey ? m.redo() : m.undo(); return; }
      if (e.key === "Enter") { if (segPick) runSeg(); else finish(); }
      else if (e.key === "Escape") { setDraft([]); setSel(null); setSegPick(null); }
      else if ((e.key === "Delete" || e.key === "Backspace") && sel) { m.setDoc({ ...doc, layers: doc.layers.filter((l) => l.id !== sel) }); setSel(null); }
      else if (e.key === " ") { e.preventDefault(); player.current?.toggle(); }
      else { const t = tools.find((x) => x.key === e.key.toUpperCase()); if (t) { setTool(t.id); setDraft([]); } }
    };
    addEventListener("keydown", k); return () => removeEventListener("keydown", k);
  });
  const svg = useRef<SVGSVGElement>(null);
  const toOut = (e: { clientX: number; clientY: number }): Pt => { const r = svg.current!.getBoundingClientRect(); return [((e.clientX - r.left) / r.width) * OW, ((e.clientY - r.top) / r.height) * OH]; };
  const toDoc = (e: { clientX: number; clientY: number }): Pt => { const [x, y] = toOut(e); const p = P.back(frame, x, y); return [Number(p[0].toFixed(4)), Number(p[1].toFixed(4))]; };
  const onDown = (e: React.PointerEvent) => {
    if (playing) { player.current?.pause(); return; }
    if (tool === "select") { setSel(null); return; }
    if (tool === "frame") { dragFrame(e); return; }
    if (tool === "seg") {
      // the click as a fraction of the tracked frame at this frame; all clicks go to SAM 2 together, on one frame
      const fi = Math.min(P.n - 1, Math.max(0, frame));
      const [X, Y] = toOut(e), fx = (X + (P.cropX[fi] ?? 0)) / P.k / doc.srcW, fy = (Y + (P.cropY[fi] ?? 0)) / P.k / doc.srcH;
      if (!Number.isFinite(fx) || !Number.isFinite(fy)) return;
      const pt: Pt = [Number(Math.min(1, Math.max(0, fx)).toFixed(4)), Number(Math.min(1, Math.max(0, fy)).toFixed(4))];
      setSegPick((s) => (s && s.f === fi ? { ...s, pts: [...s.pts, pt].slice(0, 12) } : { f: fi, pts: [pt], hl: !doc.layers.some((l) => l.type === "seg" && l.hl) }));
      return;
    }
    const p = toDoc(e);
    if (tool === "label") add({ id: `u${uid()}`, type: "label", pt: p, text: "CHỮ MỚI", size: 70, in: 1 });
    else if (tool === "pin") add({ id: `u${uid()}`, type: "pin", pt: p, text: "Địa điểm", in: 1 });
    else if (tool === "callout") add({ id: `u${uid()}`, type: "callout", pt: p, icon: "star", title: CALLOUT_ICONS.star.name, in: 1 });
    else if (e.detail >= 2) finish();
    else setDraft([...draft, p]);
  };
  // drag a handle (one point) or the whole layer
  const dragLayer = (id: string, idx: number | null) => (e: React.PointerEvent) => {
    if (tool !== "select" || playing) return;
    e.stopPropagation(); setSel(id);
    const start = toDoc(e), base = doc, L0 = base.layers.find((l) => l.id === id)!;
    const arc = "pts" in L0 ? L0.pts.reduce<number[]>((a, q, i) => [...a, i ? a[i - 1] + Math.hypot(q[0] - L0.pts[i - 1][0], q[1] - L0.pts[i - 1][1]) : 0], []) : [];
    const n = "pts" in L0 ? L0.pts.length : 1, R = n > 12 ? Math.max(0.03, (arc[n - 1] / n) * Math.ceil(n / 12) * 1.2) : 1e-6;
    let moved = false;
    const mv = (ev: PointerEvent) => {
      const p = toDoc(ev), dx = p[0] - start[0], dy = p[1] - start[1];
      moved = true;
      const shift = (q: Pt): Pt => [Number((q[0] + dx).toFixed(4)), Number((q[1] + dy).toFixed(4))];
      // a handle pulls its neighbours along with a soft falloff, so a dense road bends instead of kinking
      const pull = (q: Pt, i: number): Pt => {
        if (idx === null) return shift(q);
        if (!("pts" in L0)) return q;
        const d = arc[i] - arc[idx], w = Math.abs(d) >= R ? 0 : 0.5 + 0.5 * Math.cos((Math.PI * d) / R);
        return w ? [Number((q[0] + dx * w).toFixed(4)), Number((q[1] + dy * w).toFixed(4))] : q;
      };
      if (L0.type === "seg") return;   // its outline comes from SAM 2, frame by frame
      const nl = ("pts" in L0 ? { ...L0, pts: L0.pts.map(pull) } : { ...L0, pt: idx === null ? shift(L0.pt) : p }) as Layer;
      m.setDoc({ ...base, layers: base.layers.map((l) => (l.id === id ? nl : l)) }, false);
    };
    const up = () => { removeEventListener("pointermove", mv); removeEventListener("pointerup", up); void moved; };
    // one undo step for the whole drag
    m.setDoc(base, true);
    addEventListener("pointermove", mv); addEventListener("pointerup", up);
  };
  // drag the 9:16 window: the spot under its middle becomes a framing key at this frame (one undo step per drag)
  const dragFrame = (e: React.PointerEvent) => {
    const base = doc, P0 = P, f = frame, cf = f + P0.t0, cx0 = P0.cropX[f], cy0 = P0.cropY[f], [x0, y0] = toOut(e);
    const keys = (base.pan ?? []).filter((q) => Math.abs(q.f - cf) > 2);   // keys live in frames of the cut
    const mv = (ev: PointerEvent) => {
      const [x, y] = toOut(ev);
      const cx = Math.min(P0.videoW - OW, Math.max(0, cx0 - (x - x0))), cy = Math.min(P0.videoH - OH, Math.max(0, cy0 - (y - y0)));
      const pt = P0.back(f, OW / 2 + cx - cx0, OH / 2 + cy - cy0);
      m.setDoc({ ...base, pan: [...keys, { f: cf, pt: [Number(pt[0].toFixed(4)), Number(pt[1].toFixed(4))] as Pt }].sort((a, b) => a.f - b.f) }, false);
    };
    const up = () => { removeEventListener("pointermove", mv); removeEventListener("pointerup", up); };
    m.setDoc(base, true);
    mv(e.nativeEvent);
    addEventListener("pointermove", mv); addEventListener("pointerup", up);
  };
  const runSeg = () => {
    if (!segPick?.pts.length) return;
    m.segment(segPick.f + P.t0, segPick.pts.map((p, i) => [p[0], p[1], 1, i]), segPick.hl);
    setSegPick(null); setTool("select");
  };
  // the wheel zooms while framing; a burst of wheel steps is one undo step
  const wheelAt = useRef(0);
  const onWheel = (e: React.WheelEvent) => {
    if (tool !== "frame" || playing) return;
    const z = Math.min(2.5, Math.max(1, Math.round(((doc.zoom ?? 1) - Math.sign(e.deltaY) * 0.05) * 100) / 100));
    if (z === (doc.zoom ?? 1)) return;
    const now = Date.now();
    m.setDoc({ ...doc, zoom: z }, now - wheelAt.current > 600);
    wheelAt.current = now;
  };
  // slide a road's pill / sign along the road: the nearest point on it, as a fraction of its length
  const dragName = (r: RoadLayer) => (e: React.PointerEvent) => {
    if (tool !== "select" || playing) return;
    e.stopPropagation();
    const base = doc, total = polyLen(r.pts) || 1;
    const mv = (ev: { clientX: number; clientY: number }) => {
      const p = toDoc(ev);
      let best = Infinity, s = 0, run = 0;
      for (let i = 0; i < r.pts.length - 1; i++) {
        const a = r.pts[i], b = r.pts[i + 1], dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy) || 1e-9;
        const u = Math.min(1, Math.max(0, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (L * L)));
        const d = Math.hypot(a[0] + dx * u - p[0], a[1] + dy * u - p[1]);
        if (d < best) { best = d; s = run + u * L; }
        run += L;
      }
      m.setDoc({ ...base, layers: base.layers.map((l) => (l.id === r.id ? { ...r, nameAt: Number((s / total).toFixed(4)) } : l)) }, false);
    };
    const up = () => { removeEventListener("pointermove", mv); removeEventListener("pointerup", up); };
    m.setDoc(base, true);
    addEventListener("pointermove", mv); addEventListener("pointerup", up);
  };
  // the style cards are memoised: they call the latest picker through a ref
  const pick = useRef<(st: LineStyle) => void>(() => undefined);
  pick.current = (st) => m.setDoc({ ...doc, layers: doc.layers.map((l) => (l.type === "road" && (all || !selRoad || l.id === sel) ? { ...l, style: st } : l)) });
  const S = OW / 960; // handle size in output pixels
  const step = (n: number) => Math.max(1, Math.ceil(n / 12)); // about a dozen handles on a long road
  const at = (p: Pt) => P.out(frame, p);
  const selL = doc.layers.find((l) => l.id === sel);
  const selRoad = selL?.type === "road" ? (selL as RoadLayer) : null;
  // the roads the gallery's buttons act on (the selected one, or all of them), and the setting they share, if any:
  // that is the button shown as on
  const targets = (doc.layers.filter((l) => l.type === "road") as RoadLayer[]).filter((r) => all || !selRoad || r.id === sel);
  const common = <K extends keyof RoadLayer>(k: K, dflt: RoadLayer[K]) => {
    const vs = targets.map((r) => r[k] ?? dflt);
    return vs.length && vs.every((v) => v === vs[0]) ? vs[0] : undefined;
  };
  const weak = m.st?.meta?.track?.weak ?? [];
  // buildings need the 3D camera, which comes from the map fit
  const tools = TOOLS.filter((t) => (t.id !== "frame" || canPan(doc)) && (t.id !== "building" || !!doc.ground));
  return (
    <div className="me-editor">
      <div className="me-toolbar">
        {[...tools].sort((a, b) => TOOL_GROUP[a.id] - TOOL_GROUP[b.id]).map((t, i, arr) => (
          <React.Fragment key={t.id}>
            {i && TOOL_GROUP[arr[i - 1].id] !== TOOL_GROUP[t.id] ? <span className="me-sep" /> : null}
            <button className={`me-tool ${tool === t.id ? "on" : ""}`} title={`${t.hint} · phím ${t.key}`} onClick={() => { setTool(t.id); setDraft([]); }}>
              <svg viewBox="0 0 24 24" className="me-tool-ic"><path d={TOOL_ICONS[t.id]} /></svg>{t.name}
            </button>
          </React.Fragment>
        ))}
        <span className="me-sep" />
        <button className="me-tool" title="Hoàn tác (⌘Z)" onClick={m.undo}>↶</button>
        <button className="me-tool" title="Làm lại (⇧⌘Z)" onClick={m.redo}>↷</button>
        <button className="me-tool" disabled={!sel} title="Xoá lớp đang chọn (Delete)" onClick={() => { m.setDoc({ ...doc, layers: doc.layers.filter((l) => l.id !== sel) }); setSel(null); }}>Xoá</button>
        <span className="me-sep" />
        <span className="dim me-tip">{playing ? "Đang phát: dừng lại để sửa" : (tools.find((t) => t.id === tool) ?? TOOLS[0]).hint}</span>
        {m.compare ? <button className="me-tool on" onClick={() => m.setCompare(false)}>Đóng ảnh thử LUT</button> : null}
        <button className={`me-tool ${split !== null ? "on" : ""}`} title="Kéo vạch để so màu trước và sau" onClick={() => setSplit(split === null ? 0.5 : null)}>Trước / sau</button>
      </div>
      {/* what the tool in hand does, in plain words, while it is in hand */}
      {tool !== "select" && !playing ? (
        <div className="me-hintbar"><svg viewBox="0 0 24 24" className="me-tool-ic"><path d={TOOL_ICONS[tool]} /></svg>
          <span>{(tools.find((t) => t.id === tool) ?? TOOLS[0]).hint}</span><button className="me-link" onClick={() => { setTool("select"); setDraft([]); setSegPick(null); }}>Xong · Esc</button></div>
      ) : null}
      <div className="me-view">
        <div className="me-box" style={{ width: `min(100cqw, calc(100cqh * ${OW} / ${OH}))`, aspectRatio: `${OW} / ${OH}` }}>
          {m.compare ? (m.busy ? <div className="stage-empty">Đang tạo ảnh trước / sau…</div> : <Compare name={m.name} stamp={m.st?.status?.time ?? 0} />) : (
            <>
              <Player ref={player} component={MapShot as never} inputProps={{ doc: shown, split }} durationInFrames={docFrames(doc)} fps={doc.fps}
                compositionWidth={OW} compositionHeight={OH} loop style={{ width: "100%", height: "100%" }} />
              {split !== null ? <SplitBar split={split} setSplit={setSplit} /> : null}
              <svg ref={svg} className={`me-over ${playing ? "playing" : ""} t-${tool}`} viewBox={`0 0 ${OW} ${OH}`} onPointerDown={onDown} onWheel={onWheel}
                onPointerMove={(e) => (draft.length ? setMouse(toOut(e)) : null)}>
                {!playing ? doc.layers.filter((l) => !l.hidden).map((l) => {
                  const on = l.id === sel;
                  if (l.type === "road" || l.type === "area" || l.type === "building") {
                    const closed = l.type !== "road";
                    const q = l.pts.map(at), d = `M${q.map((p) => p.join(",")).join(" L")}${closed ? " Z" : ""}`;
                    return (
                      <g key={l.id}>
                        <path d={d} className="ghost" strokeWidth={2 * S} fill="none" />
                        {/* a building's box on screen, so a real tower can be matched (base and roof) */}
                        {l.type === "building" && cams && (on || l.real) ? prismEdges(l.pts.map(cams.metres), l.height, cams.at(frame), (p) => P.toOut(frame, p)).map(([a, b], i) => (
                          <line key={`w${i}`} x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} className={`wire ${l.real ? "real" : ""}`} strokeWidth={(on ? 2 : 1.2) * S} />
                        )) : null}
                        <path d={d} className={`hit ${on ? "on" : ""}`} strokeWidth={28 * S} fill={closed ? "transparent" : "none"} onPointerDown={dragLayer(l.id, null)} />
                        {on ? q.map((p, i) => (i % step(q.length) === 0 || i === q.length - 1
                          ? <circle key={i} cx={p[0]} cy={p[1]} r={7 * S} className="handle" onPointerDown={dragLayer(l.id, i)} /> : null)) : null}
                        {on && l.type === "road" && l.name && (l.nameStyle === "pill" || l.nameStyle === "sign") ? (() => {
                          const sp = nameSpot(l, P, doc.fps), c = sp ? at(sp) : null;
                          return c ? <rect x={c[0] - 11 * S} y={c[1] - 11 * S} width={22 * S} height={22 * S} transform={`rotate(45 ${c[0]} ${c[1]})`}
                            className="handle name" onPointerDown={dragName(l)}><title>Kéo để dời tên đường dọc theo đường</title></rect> : null;
                        })() : null}
                      </g>
                    );
                  }
                  if (l.type === "seg") {
                    // the outline SAM 2 found on this frame: click it to select the layer
                    const d = segPolys(segs[l.src], frame + P.t0, (p) => P.toOut(frame, p)).map((q) => `M${q.map((p) => p.join(",")).join(" L")} Z`).join(" ");
                    return d ? <path key={l.id} d={d} className={`hit seg ${on ? "on" : ""}`} strokeWidth={2 * S} onPointerDown={(e) => { if (tool !== "select" || playing) return; e.stopPropagation(); setSel(l.id); }} /> : null;
                  }
                  const p = at(l.pt);
                  return <circle key={l.id} cx={p[0]} cy={p[1]} r={on ? 14 * S : 11 * S} className={`hit pt ${on ? "on" : ""}`} onPointerDown={dragLayer(l.id, null)} />;
                }) : null}
                {segPick && segPick.f === frame ? segPick.pts.map((p, i) => {
                  const q = P.toOut(frame, [p[0] * doc.srcW, p[1] * doc.srcH]);
                  return <Marker key={`sp${i}`} x={q[0]} y={q[1]} n={i + 1} s={S * 1.4} c={i === 0 && segPick.hl ? "#ffd166" : PAIR_COLORS[(i + 1) % PAIR_COLORS.length]} />;
                }) : null}
                {draft.length ? (
                  <>
                    <polyline points={[...draft.map(at), ...(mouse ? [mouse] : [])].map((p) => p.join(",")).join(" ")} className="drawing" strokeWidth={4 * S} />
                    {draft.map(at).map((p, i) => <circle key={i} cx={p[0]} cy={p[1]} r={6 * S} className="handle" />)}
                  </>
                ) : null}
              </svg>
            </>
          )}
        </div>
      </div>
      {segPick ? (
        <div className="me-segbar">
          <b>{segPick.pts.length} toà đã chọn</b>
          <span className="dim">{segPick.f !== frame ? "Quay lại giây đã bấm để thấy các điểm" : "Bấm thêm vào các toà khác nếu cần"}</span>
          <label className="check" style={{ margin: 0 }}><input type="checkbox" checked={segPick.hl} onChange={(e) => setSegPick({ ...segPick, hl: e.target.checked })} />Làm nổi toà số 1, các toà còn lại chỉ để che đường</label>
          <button className="btn small" onClick={runSeg}>Lần theo {segPick.pts.length} toà</button>
          <button className="btn ghost small" onClick={() => setSegPick(null)}>Huỷ</button>
        </div>
      ) : null}
      {weak.length ? (
        <div className="me-warn">Đoạn {weak.map(([a, b]) => `${a.toFixed(1)}–${b.toFixed(1)} s`).join(", ")} máy bay quá nhanh hoặc hình bị nhoè nên khó bám mặt đất (vạch đỏ trên thanh thời gian): lớp vẽ có thể lệch một chút ở đó.</div>
      ) : null}
      <Transport player={player} tick={tick} frames={docFrames(doc)} fps={doc.fps} playing={playing} keys={doc.pan?.map((q) => q.f - P.t0)}
        weak={weak.map(([a, b]) => [a - P.t0 / doc.fps, b - P.t0 / doc.fps] as [number, number])} />
      <div className="me-gallery">
        <div className="me-gal-head">
          <b>Kiểu nét</b><span className="dim">{selRoad ? `cho “${selRoad.name || "đường đang chọn"}”` : "chọn một đường, hoặc áp cho tất cả"} · rê chuột để xem thử</span>
          <span className="me-sizes inline">
            {LINE_SIZES.map((z) => (
              <button key={z.w} className={`me-chipbtn ${common("width", 8) === z.w ? "on" : ""}`} title={`Độ dày ${z.w} px`}
                onClick={() => m.setDoc({ ...doc, layers: doc.layers.map((l) => (l.type === "road" && (all || !selRoad || l.id === sel) ? { ...l, width: z.w } : l)) })}>
                <i style={{ height: Math.max(2, z.w / 3) }} />{z.name}</button>
            ))}
          </span>
          <label className="check" style={{ margin: 0 }}><input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} />Áp cho tất cả đường</label>
        </div>
        <div className="me-styles">
          {LINE_STYLES.map((s) => (
            <StyleCard key={s.id} id={s.id} name={s.name} doc={doc} road={selRoad} on={common("style", "glow") === s.id}
              onHover={(h) => setHover(h ? { style: s.id } : null)}
              onPick={() => pick.current(s.id)} />
          ))}
        </div>
        <div className="me-names">
          <b>Tên đường</b>
          {NAME_STYLES.map((s) => (
            <button key={s.id} className={`me-chipbtn ${common("nameStyle", "along") === s.id ? "on" : ""}`} onMouseEnter={() => setHover({ nameStyle: s.id })} onMouseLeave={() => setHover(null)}
              onClick={() => m.setDoc({ ...doc, layers: doc.layers.map((l) => (l.type === "road" && (all || !selRoad || l.id === sel) ? { ...l, nameStyle: s.id } : l)) })}>{s.name}</button>
          ))}
        </div>
      </div>
    </div>
  );
}

function Transport({ player, tick, frames, fps, playing, keys, weak = [] }: { player: React.RefObject<PlayerRef | null>; tick: React.MutableRefObject<(f: number) => void>; frames: number; fps: number; playing: boolean; keys?: number[]; weak?: [number, number][] }) {
  const [frame, setFrame] = useState(() => player.current?.getCurrentFrame() ?? 0);
  tick.current = setFrame;
  const seek = (f: number) => { player.current?.pause(); player.current?.seekTo(f); };
  return (
    <div className="me-transport">
      <button className="icon-btn play" onClick={() => player.current?.toggle()} title="Phát / dừng (Space)">{playing ? "❚❚" : "▶"}</button>
      <div className="me-scrub">
        <input type="range" min={0} max={frames - 1} value={frame} onChange={(e) => seek(Number(e.target.value))} />
        {weak.map(([a, b]) => <span key={a} className="me-weak" style={{ left: `${(a * fps / frames) * 100}%`, width: `${((b - a) * fps / frames) * 100}%` }} />)}
        {/* framing keys: a click goes there */}
        {keys?.map((f) => <span key={f} className="me-key" style={{ left: `${(f / Math.max(1, frames - 1)) * 100}%` }} title={`Điểm lia ở ${(f / fps).toFixed(1)} s`} onClick={() => seek(f)} />)}
      </div>
      <span className="me-num">{(frame / fps).toFixed(1)} / {(frames / fps).toFixed(1)} s</span>
    </div>
  );
}

/** One line style, animated on the clip's own first frame: the selected road, else the longest one. */
const StyleCard = React.memo(StyleCardRaw, (a, b) => a.id === b.id && a.on === b.on && a.road === b.road && a.doc.layers === b.doc.layers && a.doc.clip === b.doc.clip);
function StyleCardRaw({ id, name, doc, road, on, onHover, onPick }: { id: LineStyle; name: string; doc: MapDoc; road: RoadLayer | null; on: boolean; onHover: (h: boolean) => void; onPick: () => void }) {
  const [t, setT] = useState(0);
  const [live, setLive] = useState(false);
  useEffect(() => {
    if (!live) { setT(2.6); return; }
    let raf = 0; const t0 = performance.now();
    const tick = () => { setT(((performance.now() - t0) / 1000) % 4); raf = requestAnimationFrame(tick); };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [live]);
  const W = doc.srcW, H = doc.srcH;
  const r = road ?? (doc.layers.filter((l) => l.type === "road") as RoadLayer[]).sort((a, b) => b.pts.length - a.pts.length)[0];
  const pts: Pt[] = r ? r.pts.map(([x, y]) => [x * W, y * H]) : [[0.1 * W, 0.7 * H], [0.4 * W, 0.5 * H], [0.7 * W, 0.55 * H], [0.95 * W, 0.3 * H]];
  // the perspective styles are shown with the clip's own first-frame camera
  const cams = useCameras(doc, useProjection(doc));
  const in3d = !!(cams && r && isRoad3D(id));
  return (
    <button className={`me-style ${on ? "on" : ""}`} onMouseEnter={() => { onHover(true); setLive(true); }} onMouseLeave={() => { onHover(false); setLive(false); }} onClick={onPick}>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid slice">
        <image href={`/files/output/drone/${doc.clip.split("/")[0].replace(/^map-/, "")}/frame.jpg`} width={W} height={H} preserveAspectRatio="xMidYMid slice" opacity={0.75} />
        {in3d ? <Road3D id={`g-${id}`} foot={r!.pts.map(cams!.metres)} cam={cams!.at(0)} toOut={(p) => p} style={id as never} color={r!.color} width={(r!.width ?? 8) * ROAD_M}
            speed={r!.speed ?? 1} t={t} t0={0} W={W} H={H} />
          : <LineArt id={`g-${id}`} pts={pts} style={id} color={r?.color ?? "#ffb02e"} width={(r?.width ?? 8) * 1.6} speed={r?.speed ?? 1} t={t} t0={0} />}
      </svg>
      <span>{name}</span>
    </button>
  );
}

/** The before / after line over the live player: drag it anywhere. */
function SplitBar({ split, setSplit }: { split: number; setSplit: (v: number) => void }) {
  const drag = (e: React.PointerEvent) => {
    e.preventDefault(); e.stopPropagation();
    const box = (e.currentTarget.parentElement as HTMLElement).getBoundingClientRect();
    const mv = (ev: PointerEvent) => setSplit(Math.max(0.02, Math.min(0.98, (ev.clientX - box.left) / box.width)));
    const up = () => { removeEventListener("pointermove", mv); removeEventListener("pointerup", up); };
    addEventListener("pointermove", mv); addEventListener("pointerup", up);
  };
  return (
    <>
      <div className="me-split live" style={{ left: `${split * 100}%` }} onPointerDown={drag}><span className="me-knob">⇆</span></div>
      <span className="me-tag l">Trước</span><span className="me-tag r">Sau</span>
    </>
  );
}

/** Before / after a LUT (one frame from the server), split by a line the user drags. */
function Compare({ name, stamp }: { name: string; stamp: number }) {
  const [x, setX] = useState(0.5);
  const v = stamp;
  const box = useRef<HTMLDivElement>(null);
  const move = (e: React.PointerEvent) => { if (e.buttons !== 1 && e.type !== "pointerdown") return; const r = box.current!.getBoundingClientRect(); setX(Math.max(0, Math.min(1, (e.clientX - r.left) / r.width))); };
  return (
    <div className="me-compare" ref={box} onPointerDown={move} onPointerMove={move}>
      <img src={`/files/output/drone/${name}/after.jpg?v=${v}`} alt="" draggable={false} />
      <img src={`/files/output/drone/${name}/before.jpg?v=${v}`} alt="" draggable={false} style={{ clipPath: `inset(0 ${(1 - x) * 100}% 0 0)` }} />
      <div className="me-split" style={{ left: `${x * 100}%` }} />
      <span className="me-tag l">Trước</span><span className="me-tag r">Sau</span>
    </div>
  );
}
