/**
 * Drone shot with text and light trails "stuck" to the ground, real-estate-reel style: labels lie on the ground in
 * perspective, glowing trails run along a road, green light leaks and a dark-green vignette on top ("mint"); or the
 * "gold" look: warm haze, golden road lines with the road's name along them, teal tags on stems, a caption bar.
 * Positions come from scripts/track.py + scripts/tracked-prep.py (tracked.json: corners / points per frame).
 */
import { AbsoluteFill, Easing, OffthreadVideo, interpolate, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { FONT } from "../font";

type Pt = [number, number];
export type TrackedData = {
  fps: number; frames: number; width?: number; height?: number; theme?: "mint" | "gold"; videoWidth: number; cropX: number[];
  labels: { lines: string[]; kind?: "ground" | "road"; in: number; quads: Pt[][] }[];
  trails: { in: number; color?: keyof typeof TRAIL; pts: Pt[][] }[];
  pins?: { text: string; in: number; pts: Pt[] }[];
  title?: { text: string; in?: number } | null;
  areas?: { label?: string | null; in: number; lift: number; color?: keyof typeof TRAIL | string; pts: Pt[][] }[];
  /** map data credit, e.g. "© OpenStreetMap contributors" (required when the roads come from OSM) */
  credit?: string | null;
};

const MINT = "#46ffc4", TEAL = "#0b5c4c";
export const TRAIL = { mint: { glow: MINT, core: "#d8fff0", pulse: "#ffffff" }, gold: { glow: "#ffb02e", core: "#fff7e0", pulse: "#ffffff" },
  green: { glow: "#3dff6e", core: "#eaffef", pulse: "#ffffff" },
  blue: { glow: "#3aa8ff", core: "#e6f4ff", pulse: "#ffffff" },
  white: { glow: "#ffffff", core: "#ffffff", pulse: "#fff6d8" } };

/** CSS matrix3d mapping the rectangle (0,0)-(w,h) onto quad q (top-left, top-right, bottom-right, bottom-left). */
export function rectToQuad(w: number, h: number, q: Pt[]) {
  const src: Pt[] = [[0, 0], [w, 0], [w, h], [0, h]];
  const A: number[][] = [], b: number[] = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i], [u, v] = q[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
  }
  // Gaussian elimination
  for (let c = 0; c < 8; c++) {
    let p = c;
    for (let r = c + 1; r < 8; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]]; [b[c], b[p]] = [b[p], b[c]];
    for (let r = 0; r < 8; r++) {
      if (r === c) continue;
      const f = A[r][c] / A[c][c];
      for (let k = c; k < 8; k++) A[r][k] -= f * A[c][k];
      b[r] -= f * b[c];
    }
  }
  const h8 = b.map((v, i) => v / A[i][i]);
  const [a0, a1, a2, a3, a4, a5, a6, a7] = h8;
  return `matrix3d(${a0},${a3},0,${a6},${a1},${a4},0,${a7},0,0,1,0,${a2},${a5},0,1)`;
}

/** Smooth path through points (Catmull-Rom → cubic Bézier). */
export function smooth(p: Pt[]) {
  let d = `M${p[0][0]},${p[0][1]}`;
  for (let i = 0; i < p.length - 1; i++) {
    const p0 = p[Math.max(0, i - 1)], p1 = p[i], p2 = p[i + 1], p3 = p[Math.min(p.length - 1, i + 2)];
    d += ` C${p1[0] + (p2[0] - p0[0]) / 6},${p1[1] + (p2[1] - p0[1]) / 6} ${p2[0] - (p3[0] - p1[0]) / 6},${p2[1] - (p3[1] - p1[1]) / 6} ${p2[0]},${p2[1]}`;
  }
  return d;
}
export const lengthOf = (p: Pt[]) => p.slice(1).reduce((s, q, i) => s + Math.hypot(q[0] - p[i][0], q[1] - p[i][1]), 0);

/** A label drawn flat, then laid on the ground quad. */
export const GroundLabel: React.FC<{ lines: string[]; quad: Pt[]; t: number; at: number; id: number }> = ({ lines, quad, t, at, id }) => {
  const W = 1200, LH = 230, H = LH * lines.length + 40;
  const k = interpolate(t, [at, at + 0.9], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.out(Easing.cubic) });
  const glint = interpolate(t, [at + 0.5, at + 1.6], [-0.4, 1.4], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  if (k <= 0) return null;
  return (
    <div style={{ position: "absolute", left: 0, top: 0, width: W, height: H, transformOrigin: "0 0", transform: rectToQuad(W, H, quad), opacity: k }}>
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} style={{ overflow: "visible" }}>
        <defs>
          <linearGradient id={`fill${id}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#ffffff" /><stop offset="0.55" stopColor="#d9fff1" /><stop offset="1" stopColor="#7fe9c9" />
          </linearGradient>
          <linearGradient id={`glint${id}`} x1="0" y1="0" x2="1" y2="0.3">
            <stop offset={Math.min(1, Math.max(0, glint - 0.12))} stopColor="#fff" stopOpacity="0" />
            <stop offset={Math.min(1, Math.max(0, glint))} stopColor="#fff" stopOpacity="0.95" />
            <stop offset={Math.min(1, Math.max(0, glint + 0.12))} stopColor="#fff" stopOpacity="0" />
          </linearGradient>
          <filter id={`glow${id}`} x="-20%" y="-40%" width="140%" height="180%"><feGaussianBlur stdDeviation="18" /></filter>
          {/* fresh id per step: Chrome keeps a stale clip inside 3D-transformed layers when only the rect changes */}
          {k < 1 ? <clipPath id={`wipe${id}-${Math.round(k * 1000)}`}><rect x={0} y={-50} width={W * k} height={H + 100} /></clipPath> : null}
        </defs>
        <g clipPath={k < 1 ? `url(#wipe${id}-${Math.round(k * 1000)})` : undefined}>
          {lines.map((ln, i) => {
            const y = 20 + LH * (i + 0.82);
            const common = { x: W / 2, y, textAnchor: "middle" as const, textLength: W - 40, lengthAdjust: "spacingAndGlyphs" as const,
              fontFamily: FONT, fontWeight: 900, fontSize: LH * 0.92 };
            return (
              <g key={i}>
                <text {...common} fill={MINT} opacity={0.75} filter={`url(#glow${id})`}>{ln}</text>
                {/* shadow cast toward the camera, then a dark rim for depth */}
                <text {...common} y={y + 16} fill="rgba(0,30,24,0.55)">{ln}</text>
                <text {...common} fill={`url(#fill${id})`} stroke={TEAL} strokeWidth={10} paintOrder="stroke">{ln}</text>
                <text {...common} fill={`url(#glint${id})`}>{ln}</text>
              </g>
            );
          })}
        </g>
      </svg>
    </div>
  );
};

/** Light trails along a road: draw on, then bright pulses keep running along it. */
const Trails: React.FC<{ data: TrackedData; f: number; t: number }> = ({ data, f, t }) => {
  const base = TRAIL[data.theme ?? "mint"];
  return (
  <svg width={data.width ?? 1080} height={data.height ?? 1920} style={{ position: "absolute", inset: 0 }}>
    <defs>
      <filter id="tglow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="9" /></filter>
      <filter id="tsoft" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="2" /></filter>
    </defs>
    {data.trails.map((tr, i) => {
      const pts = tr.pts[f], d = smooth(pts), L = lengthOf(pts), C = tr.color ? TRAIL[tr.color] : base;
      const draw = interpolate(t, [tr.in + i * 0.08, tr.in + 1.1 + i * 0.08], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.out(Easing.quad) });
      const run = (t * (520 + i * 90) + i * 310) % (L + 600);
      return (
        <g key={i} style={{ mixBlendMode: data.theme === "gold" ? "normal" : "screen" }}>
          <path d={d} fill="none" stroke={C.glow} strokeWidth={data.theme === "gold" ? 16 : 34} opacity={data.theme === "gold" ? 0.9 : 0.5}
            filter="url(#tglow)" strokeLinecap="round" strokeDasharray={`${L * draw} ${L}`} />
          <path d={d} fill="none" stroke={C.core} strokeWidth={data.theme === "gold" ? 7 : 5} opacity={1} strokeLinecap="round"
            strokeDasharray={`${L * draw} ${L}`} />
          <path d={d} fill="none" stroke={C.pulse} strokeWidth={data.theme === "gold" ? 6 : 9} opacity={(data.theme === "gold" ? 0.55 : 0.95) * draw}
            filter="url(#tsoft)" strokeLinecap="round"
            strokeDasharray={`140 ${L + 600}`} strokeDashoffset={-run + 140} />
          {data.theme === "gold" ? null : (
            <path d={d} fill="none" stroke={C.glow} strokeWidth={26} opacity={0.75 * draw} filter="url(#tglow)" strokeLinecap="round"
              strokeDasharray={`220 ${L + 600}`} strokeDashoffset={-run + 220} />
          )}
        </g>
      );
    })}
  </svg>
  );
};

/** A road's name lying along it: plain white letters with a soft shadow, revealed left to right. */
export const RoadLabel: React.FC<{ text: string; quad: Pt[]; t: number; at: number; id: number }> = ({ text, quad, t, at, id }) => {
  const H = 200, W = Math.round(H * 0.62 * text.length); // the same proportions tracked-prep uses for the quad
  const k = interpolate(t, [at, at + 1.0], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.out(Easing.cubic) });
  if (k <= 0) return null;
  const common = { x: W / 2, y: H * 0.8, textAnchor: "middle" as const, textLength: W - 20, lengthAdjust: "spacingAndGlyphs" as const,
    fontFamily: FONT, fontWeight: 800, fontSize: H * 0.85 };
  const clip = `road${id}-${Math.round(k * 1000)}`;
  return (
    <div style={{ position: "absolute", left: 0, top: 0, width: W, height: H, transformOrigin: "0 0", transform: rectToQuad(W, H, quad), opacity: Math.min(1, k * 1.5) }}>
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} style={{ overflow: "visible" }}>
        <defs>
          <filter id={`rsh${id}`} x="-10%" y="-50%" width="120%" height="200%"><feGaussianBlur stdDeviation="8" /></filter>
          {k < 1 ? <clipPath id={clip}><rect x={0} y={-60} width={W * k} height={H + 120} /></clipPath> : null}
        </defs>
        <g clipPath={k < 1 ? `url(#${clip})` : undefined}>
          <text {...common} y={H * 0.8 + 14} fill="rgba(0,0,0,0.55)" filter={`url(#rsh${id})`}>{text}</text>
          <text {...common} fill="#ffffff">{text}</text>
        </g>
      </svg>
    </div>
  );
};

/** A tag on a stem standing on a ground point: a glowing dot, the stem grows up, then the teal tag. */
export const Pin: React.FC<{ text: string; p: Pt; t: number; at: number }> = ({ text, p, t, at }) => {
  const stem = interpolate(t, [at, at + 0.5], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.out(Easing.cubic) });
  const tag = interpolate(t, [at + 0.35, at + 0.8], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.out(Easing.back(1.6)) });
  if (stem <= 0) return null;
  const SH = 120, ring = ((t - at) % 1.6) / 1.6;
  return (
    <div style={{ position: "absolute", left: p[0], top: p[1], width: 0, height: 0 }}>
      <div style={{ position: "absolute", left: -7, top: -7, width: 14, height: 14, borderRadius: "50%", background: "#fff",
        boxShadow: "0 0 14px 6px rgba(120,240,255,0.85)" }} />
      <div style={{ position: "absolute", left: -7 - 20 * ring, top: -7 - 8 * ring, width: 14 + 40 * ring, height: 14 + 16 * ring, borderRadius: "50%",
        border: "2px solid rgba(150,245,255,0.9)", opacity: 1 - ring }} />
      <div style={{ position: "absolute", left: -1.5, top: -SH * stem, width: 3, height: SH * stem,
        background: "linear-gradient(0deg, rgba(255,255,255,0.2), #ffffff)", boxShadow: "0 0 8px rgba(160,245,255,0.9)" }} />
      <div style={{ position: "absolute", left: 0, top: -SH, transform: `translate(-50%, -100%) scale(${tag})`, transformOrigin: "50% 100%",
        padding: "8px 22px", whiteSpace: "nowrap", fontFamily: FONT, fontWeight: 800, fontSize: 30, letterSpacing: 1.5, color: "#fff",
        background: "linear-gradient(180deg, rgba(64,200,200,0.95), rgba(18,120,130,0.95))", border: "2px solid rgba(220,255,255,0.9)",
        boxShadow: "0 0 18px rgba(80,230,240,0.7), 0 6px 14px rgba(0,0,0,0.35)", textShadow: "0 2px 4px rgba(0,40,50,0.6)" }}>
        {text}
      </div>
    </div>
  );
};

/**
 * A ground area that pops up: everything outside dims and loses colour, the area itself stays bright with a warm
 * wash, a glowing rim runs round it, and its front edges grow walls downward so it reads as a slab lifted off the ground.
 */
export const Area: React.FC<{ a: NonNullable<TrackedData["areas"]>[number]; f: number; t: number; W: number; H: number; uid?: string }> = ({ a, f, t, W, H, uid = "a" }) => {
  const pts = a.pts[f], C = a.color?.startsWith("#") ? { glow: a.color, core: "#ffffff", pulse: "#ffffff" } : TRAIL[(a.color ?? "gold") as keyof typeof TRAIL];
  const k = interpolate(t, [a.in, a.in + 1.0], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.out(Easing.cubic) });
  if (k <= 0) return null;
  const d = `M${pts.map((p) => `${p[0]},${p[1]}`).join(" L")} Z`;
  const outside = `M0,0 L${W},0 L${W},${H} L0,${H} Z ${d}`;
  // signed area tells the winding, so each edge's outward normal is known
  let s2 = 0;
  pts.forEach((p, i) => { const q = pts[(i + 1) % pts.length]; s2 += p[0] * q[1] - q[0] * p[1]; });
  const sign = s2 > 0 ? 1 : -1, lift = a.lift * k;
  const walls = pts.map((p, i) => {
    const q = pts[(i + 1) % pts.length], ex = q[0] - p[0], ey = q[1] - p[1], L = Math.hypot(ex, ey) || 1;
    const ny = (sign * ex) / L; // outward normal, y part (screen y grows downward)
    return ny > 0.15 ? { p, q, shade: 0.55 + 0.45 * ny } : null;
  }).filter(Boolean) as { p: Pt; q: Pt; shade: number }[];
  const L = pts.reduce((s, p, i) => s + Math.hypot(pts[(i + 1) % pts.length][0] - p[0], pts[(i + 1) % pts.length][1] - p[1]), 0);
  const run = (t * 700) % L;
  return (
    <>
      <div style={{ position: "absolute", inset: 0, clipPath: `path(evenodd, "${outside}")`,
        backdropFilter: `brightness(${1 - 0.4 * k})`, WebkitBackdropFilter: `brightness(${1 - 0.4 * k})` }} />
      <svg width={W} height={H} style={{ position: "absolute", inset: 0 }}>
        <defs>
          <linearGradient id={`wall-${uid}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor={C.glow} stopOpacity="0.95" /><stop offset="1" stopColor={C.glow} stopOpacity="0.15" />
          </linearGradient>
          <filter id={`aglow-${uid}`} x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="10" /></filter>
          <filter id={`asoft-${uid}`} x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="2" /></filter>
        </defs>
        {walls.map((w, i) => (
          <path key={i} d={`M${w.p[0]},${w.p[1]} L${w.q[0]},${w.q[1]} L${w.q[0]},${w.q[1] + lift} L${w.p[0]},${w.p[1] + lift} Z`}
            fill={`url(#wall-${uid})`} opacity={w.shade} />
        ))}
        {walls.map((w, i) => <path key={`b${i}`} d={`M${w.p[0]},${w.p[1] + lift} L${w.q[0]},${w.q[1] + lift}`} stroke={C.core} strokeOpacity={0.5} strokeWidth={2} />)}
        <path d={d} fill={C.glow} opacity={0.14 * k} style={{ mixBlendMode: "screen" }} />
        <path d={d} fill="none" stroke={C.glow} strokeWidth={22} opacity={0.7 * k} filter={`url(#aglow-${uid})`} strokeLinejoin="round" />
        <path d={d} fill="none" stroke={C.core} strokeWidth={5} opacity={k} strokeLinejoin="round" />
        <path d={d} fill="none" stroke="#ffffff" strokeWidth={8} opacity={0.9 * k} strokeLinejoin="round" strokeLinecap="round"
          strokeDasharray={`180 ${L}`} strokeDashoffset={-run} filter={`url(#asoft-${uid})`} />
      </svg>
    </>
  );
};

/** The area's name standing over it: big gold letters on a dark glass plate. */
export const AreaTag: React.FC<{ text: string; x: number; y: number; t: number; at: number }> = ({ text, x, y, t, at }) => {
  const k = interpolate(t, [at, at + 0.6], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.out(Easing.back(1.4)) });
  if (k <= 0) return null;
  return (
    <div style={{ position: "absolute", left: x, top: y, transform: `translate(-50%, -100%) translateY(${(1 - k) * 30}px) scale(${0.8 + 0.2 * k})`, opacity: k,
      padding: "12px 30px", whiteSpace: "nowrap", fontFamily: FONT, fontWeight: 900, fontSize: 46, letterSpacing: 2,
      color: "#ffd889", background: "linear-gradient(180deg, rgba(20,24,28,0.78), rgba(10,12,14,0.62))", border: "2px solid rgba(255,206,110,0.9)",
      borderRadius: 8, boxShadow: "0 0 28px rgba(255,180,60,0.55), 0 10px 24px rgba(0,0,0,0.45)", textShadow: "0 0 14px rgba(255,190,80,0.8)" }}>
      {text}
    </div>
  );
};

/** Warm haze (gold look): a sunset glow from the top, a teal band at the bottom behind the caption, a soft vignette. */
export const Haze: React.FC<{ t: number; dur: number }> = ({ t, dur }) => {
  const flash = interpolate(t, [0, 0.2, 0.9], [0.8, 0.55, 0], { extrapolateRight: "clamp" });
  const out = interpolate(t, [dur - 0.4, dur], [0, 0.85], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  return (
    <AbsoluteFill style={{ pointerEvents: "none" }}>
      <AbsoluteFill style={{ mixBlendMode: "soft-light", background: "linear-gradient(180deg, rgba(255,160,60,0.85), rgba(255,190,110,0.35) 40%, rgba(0,0,0,0) 70%)" }} />
      <AbsoluteFill style={{ mixBlendMode: "screen", background: `radial-gradient(ellipse 60% 40% at ${70 + Math.sin(t * 0.5) * 4}% 0%, rgba(255,200,120,0.45), rgba(0,0,0,0) 70%)` }} />
      <AbsoluteFill style={{ background: "linear-gradient(0deg, rgba(10,90,110,0.75), rgba(20,120,130,0.35) 16%, rgba(0,0,0,0) 32%)" }} />
      <AbsoluteFill style={{ background: "radial-gradient(ellipse 85% 75% at 50% 45%, rgba(0,0,0,0) 60%, rgba(20,15,5,0.45) 100%)" }} />
      <AbsoluteFill style={{ mixBlendMode: "screen", opacity: flash, background: "linear-gradient(110deg, rgba(0,0,0,0) 25%, rgba(255,220,150,0.9) 50%, rgba(0,0,0,0) 75%)" }} />
      <AbsoluteFill style={{ backgroundColor: "#0a1a1c", opacity: out }} />
    </AbsoluteFill>
  );
};

/** Caption bar at the bottom left: a white bar, then the text slides in. */
export const Title: React.FC<{ text: string; t: number; at: number }> = ({ text, t, at }) => {
  const k = interpolate(t, [at, at + 0.7], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.out(Easing.cubic) });
  return (
    <div style={{ position: "absolute", left: 60, bottom: 56, display: "flex", alignItems: "center", gap: 22, opacity: k }}>
      <div style={{ width: 8, height: 78 * k, background: "#fff", boxShadow: "0 0 10px rgba(255,255,255,0.8)" }} />
      <div style={{ overflow: "hidden" }}>
        <div style={{ fontFamily: FONT, fontWeight: 800, fontSize: 60, color: "#fff", letterSpacing: 1, whiteSpace: "nowrap",
          transform: `translateX(${(1 - k) * -60}px)`, textShadow: "0 3px 10px rgba(0,30,40,0.6)" }}>{text}</div>
      </div>
    </div>
  );
};

/** Green light leaks: diagonal rays from the top right, glows in the corners, a flash at the start, a dark-green frame. */
export const Leaks: React.FC<{ t: number; dur: number }> = ({ t, dur }) => {
  const flash = interpolate(t, [0, 0.25, 1.1], [0.95, 0.75, 0], { extrapolateRight: "clamp" });
  const drift = Math.sin(t * 0.9) * 40;
  const out = interpolate(t, [dur - 0.4, dur], [0, 0.85], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  return (
    <AbsoluteFill style={{ pointerEvents: "none" }}>
      <AbsoluteFill style={{ mixBlendMode: "screen" }}>
        {[0, 1, 2, 3].map((i) => (
          <div key={i} style={{ position: "absolute", right: -260 + i * 70 + drift * (i % 2 ? 1 : -1), top: -340 + i * 30, width: 150 + i * 60, height: 1500,
            transform: `rotate(${32 + i * 5}deg)`, transformOrigin: "top right",
            background: `linear-gradient(180deg, rgba(110,255,205,${0.42 - i * 0.07}), rgba(40,200,150,0.12) 45%, rgba(0,0,0,0) 75%)`, filter: "blur(10px)" }} />
        ))}
        <div style={{ position: "absolute", left: -300 + drift, top: -260, width: 900, height: 700, borderRadius: "50%",
          background: "radial-gradient(closest-side, rgba(60,230,170,0.55), rgba(20,120,90,0.2) 60%, transparent)" }} />
        <div style={{ position: "absolute", right: -320, bottom: 120 - drift, width: 760, height: 760, borderRadius: "50%",
          background: "radial-gradient(closest-side, rgba(90,255,200,0.35), rgba(20,140,100,0.12) 60%, transparent)" }} />
        <AbsoluteFill style={{ opacity: flash, background: `linear-gradient(${120 + t * 30}deg, rgba(0,0,0,0) 20%, rgba(150,255,220,0.9) 48%, rgba(255,255,255,0.95) 52%, rgba(0,0,0,0) 80%)` }} />
      </AbsoluteFill>
      <AbsoluteFill style={{ background: "radial-gradient(ellipse 78% 58% at 50% 52%, rgba(0,0,0,0) 58%, rgba(4,48,38,0.55) 80%, rgba(2,30,24,0.92) 100%)" }} />
      <AbsoluteFill style={{ backgroundColor: "#021e18", opacity: out }} />
    </AbsoluteFill>
  );
};

export const TrackedShot: React.FC<{ data?: TrackedData; src: string; tracked?: string }> = ({ data, src }) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  if (!data) return null;
  const f = Math.min(frame, data.frames - 1), t = frame / fps, gold = data.theme === "gold";
  return (
    <AbsoluteFill style={{ backgroundColor: "#021e18", overflow: "hidden" }}>
      <OffthreadVideo src={staticFile(src)} muted
        style={{ position: "absolute", top: 0, left: -data.cropX[f], width: data.videoWidth, height: data.height ?? 1920, maxWidth: "none",
          filter: gold ? "saturate(1.08) contrast(1.08) sepia(0.12)" : "saturate(1.12) contrast(1.06) brightness(1.02)" }} />
      {(data.areas ?? []).map((a, i) => <Area key={i} a={a} f={f} t={t} W={data.width ?? 1080} H={data.height ?? 1920} />)}
      <Trails data={data} f={f} t={t} />
      {/* remount every frame: in a long render Chrome reuses the 3D layer of the label with stale bounds and clips it */}
      {data.labels.map((l, i) => l.kind === "road"
        ? <RoadLabel key={`${i}-${frame}`} id={i} text={l.lines.join(" ")} quad={l.quads[f]} t={t} at={l.in} />
        : <GroundLabel key={`${i}-${frame}`} id={i} lines={l.lines} quad={l.quads[f]} t={t} at={l.in} />)}
      {gold ? <Haze t={t} dur={durationInFrames / fps} /> : <Leaks t={t} dur={durationInFrames / fps} />}
      {(data.pins ?? []).map((p, i) => <Pin key={i} text={p.text} p={p.pts[f]} t={t} at={p.in} />)}
      {/* area names last, over the road lines */}
      {(data.areas ?? []).map((a, i) => {
        if (!a.label) return null;
        // over the part of the area that is in the picture
        const W = data.width ?? 1080, H = data.height ?? 1920;
        const vis = a.pts[f].map(([x, y]) => [Math.min(W, Math.max(0, x)), Math.min(H, Math.max(0, y))]);
        const half = (a.label.length * 0.66 * 46 + 70) / 2 + 24; // the tag's half width, so it stays inside the frame
        const x = Math.min(W - half, Math.max(half, vis.reduce((s, p) => s + p[0], 0) / vis.length));
        return <AreaTag key={i} text={a.label} x={x} y={Math.max(70, Math.min(...vis.map((p) => p[1])) - 18)} t={t} at={a.in + 0.6} />;
      })}
      {data.title ? <Title text={data.title.text} t={t} at={data.title.in ?? 0.8} /> : null}
      {data.credit ? (
        <div style={{ position: "absolute", right: 24, bottom: 16, fontFamily: FONT, fontSize: (data.height ?? 1920) > (data.width ?? 1080) ? 22 : 20,
          color: "rgba(255,255,255,0.8)", textShadow: "0 1px 3px rgba(0,0,0,0.7)" }}>{data.credit}</div>
      ) : null}
    </AbsoluteFill>
  );
};
