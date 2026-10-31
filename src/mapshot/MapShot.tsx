/**
 * MapShot: an aerial clip with roads, road names, highlighted areas, ground text and pins stuck to the ground.
 * Everything is stored once, in the first frame's coordinates (fractions of the tracked frame), together with the
 * ground tracking (one homography per frame, scripts/track.py); positions are projected per frame here, so the
 * editor in Map Studio can change a layer and see it move with the shot at once, without any render step.
 */
import React, { useMemo } from "react";
import { AbsoluteFill, Easing, OffthreadVideo, interpolate, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { FONT } from "../font";
import { Area, AreaTag, GroundLabel, Haze, Leaks, Pin, RoadLabel, Title } from "../tracked/TrackedShot";
import { Callout, calloutWidth, type CalloutIcon } from "./Callout";
import { SegHighlight, segPolys, useSegs } from "./Seg";
import { Road3D, isRoad3D } from "./Road3D";
import { Building, Highlight, Occlude, camOf, focalOf, inv9, mul9, applyH, silhouette, type Cam, type Glass, type HighlightFx } from "./Building";

export type Pt = [number, number];
export type LineStyle = "glow" | "neon" | "comet" | "arrows" | "dashes" | "dots" | "ribbon" | "outline"
  | "laser" | "pulse" | "double" | "shimmer" | "sparkle" | "electric" | "tube"
  | "surface" | "wall" | "trails" | "route" | "particles" | "gradient" | "markings" | "wave" | "grid";
export type NameStyle = "along" | "pill" | "sign" | "none";
export type Look = "gold" | "mint" | "clean";
type Base = { id: string; in?: number; hidden?: boolean };
/** `part`: the road this piece belongs to, for the extra pieces of a road that leaves and re-enters the picture */
export type RoadLayer = Base & { type: "road"; pts: Pt[]; style: LineStyle; color: string; width?: number; speed?: number; name?: string; nameStyle?: NameStyle; part?: string;
  /** where the pill / sign sits, 0..1 along the road; unset = the middle of what is in the picture when it appears */
  nameAt?: number };
export type AreaLayer = Base & { type: "area"; pts: Pt[]; label?: string; color: string };
export type PinLayer = Base & { type: "pin"; pt: Pt; text: string };
export type TextLayer = Base & { type: "label"; pt: Pt; text: string; size?: number };
/** an amenity badge (red and gold, one look for all; the icon tells what it is) on a ground spot */
export type CalloutLayer = Base & { type: "callout"; pt: Pt; title: string; sub?: string; icon: CalloutIcon };
/** a 3D building on a footprint (first-frame fractions): height in metres, plain glass or a facade image (imgQuad = the
 *  part of the image that is the facade, image fractions tl, tr, br, bl) on the front wall or on every wall */
export type BuildingLayer = Base & { type: "building"; pts: Pt[]; height: number; glass?: Glass; image?: string; imgW?: number; imgH?: number;
  imgQuad?: Pt[]; front?: number; wrap?: boolean;
  /** a building that is already in the clip: not drawn, but what lies on the ground behind it is hidden */
  real?: boolean; name?: string;
  /** made to stand out (an effect, its colour, a name over the roof) */
  hl?: { fx: HighlightFx; color: string; label?: string } };
/** a building followed through the clip by SAM 2: its outline per frame in `src` (a JSON next to the clip), highlighted
 *  like a building (hl), the rest dimmed (dim), the ground layers behind it hidden (occlude) */
export type SegLayer = Base & { type: "seg"; src: string; name?: string; hl?: { fx: HighlightFx; color: string; label?: string } | null; occlude?: boolean; dim?: boolean;
  iouMin?: number; weak?: number[] };
export type Layer = RoadLayer | AreaLayer | PinLayer | TextLayer | CalloutLayer | BuildingLayer | SegLayer;
export type Delog = "none" | "dlogm" | "dlog" | "hlg";
/** Colour that plays live (an SVG filter on the video, in the editor and in the render alike). Sliders run −100…100,
 *  exposure in stops. */
/** D-Log M has no published formula: it is always baked with DJI's LUT (scripts/mapcolor.py), never played live. */
export const liveDelogOff = (doc: Pick<MapDoc, "baked" | "grade">) => !!doc.baked || doc.grade?.delog === "dlogm";
export type Grade = { delog?: Delog; exposure?: number; contrast?: number; highlights?: number; shadows?: number; saturation?: number; temperature?: number; tint?: number };
export type MapDoc = {
  /** clip in public (with a user LUT baked in, when there is one), its pixel size, and the size of the tracked
   *  frame the homographies use; `source` is the ungraded clip, `baked` what went into `clip` */
  clip: string; clipW: number; clipH: number; srcW: number; srcH: number;
  source?: string; grade?: Grade; baked?: { delog: string; lut: string | null; lutPath?: string | null; strength: number; full?: boolean } | null;
  fps: number; frames: number; H: number[][];
  aspect: Aspect; look: Look; layers: Layer[]; title?: string; credit?: string;
  /** frames of the cut the video keeps, [first, end); unset = all of it */
  trim?: [number, number];
  /** how far the clip is blown up past covering the output (1 = just covers it), for a tighter crop */
  zoom?: number;
  /** map metres (x east, y south) → first-frame pixels: the fitted ground, which gives the 3D camera for buildings */
  ground?: number[];
  /** 9:16 only: the user's framing, the spot (first-frame fractions) in the middle of the window at frame f; the
   *  window glides between them. None = follow the highlights. */
  pan?: { f: number; pt: Pt }[];
};

export const LINE_STYLES: { id: LineStyle; name: string }[] = [
  { id: "glow", name: "Phát sáng" }, { id: "neon", name: "Neon chạy" }, { id: "comet", name: "Vẽ dần" }, { id: "arrows", name: "Mũi tên chạy" },
  { id: "dashes", name: "Nét đứt chạy" }, { id: "dots", name: "Chấm tròn" }, { id: "ribbon", name: "Ruy băng" }, { id: "outline", name: "Viền đôi" },
  { id: "laser", name: "Tia laser" }, { id: "pulse", name: "Nhịp sáng" }, { id: "double", name: "Hai vạch song song" }, { id: "shimmer", name: "Ánh kim chạy" },
  { id: "sparkle", name: "Lấp lánh" }, { id: "electric", name: "Tia điện" }, { id: "tube", name: "Ống nổi 3D" },
  // in the ground's perspective (need the 3D camera; flat stand-ins otherwise)
  { id: "surface", name: "Phủ mặt đường" }, { id: "wall", name: "Tường ánh sáng" }, { id: "trails", name: "Vệt đèn xe" }, { id: "route", name: "Lộ trình 3D" },
  { id: "particles", name: "Hạt sáng theo làn" }, { id: "gradient", name: "Dải chuyển màu" }, { id: "markings", name: "Vạch kẻ phát sáng" },
  { id: "wave", name: "Sóng sáng lan" }, { id: "grid", name: "Lưới hologram" },
];
/** metres of road for one unit of a road's width (a "Vừa" road, 8, is 12 m) */
export const ROAD_M = 1.5;
/** line sizes the editor offers as one click (the slider goes finer) */
export const LINE_SIZES = [{ name: "Mảnh", w: 4 }, { name: "Vừa", w: 8 }, { name: "Dày", w: 14 }, { name: "Rất dày", w: 22 }, { name: "Cực dày", w: 34 }];

/** a polyline moved sideways by `o` pixels (left of the direction of travel for o > 0) */
function offsetLine(p: Pt[], o: number): Pt[] {
  return p.map((q, i) => {
    const a = p[Math.max(0, i - 1)], b = p[Math.min(p.length - 1, i + 1)];
    const dx = b[0] - a[0], dy = b[1] - a[1], n = Math.hypot(dx, dy) || 1;
    return [q[0] - (dy / n) * o, q[1] + (dx / n) * o];
  });
}
/** the same small noise for the same inputs (no Math.random: every render of a frame must match) */
const noise = (i: number, k: number) => { const v = Math.sin(i * 127.1 + k * 311.7) * 43758.5453; return v - Math.floor(v); };
export const NAME_STYLES: { id: NameStyle; name: string }[] = [
  { id: "along", name: "Chữ dọc đường" }, { id: "pill", name: "Nhãn bo tròn" }, { id: "sign", name: "Biển tên đường" }, { id: "none", name: "Không ghi tên" },
];
export const COLORS = ["#ffb02e", "#ff5a4f", "#3dff6e", "#3aa8ff", "#46ffc4", "#c084ff", "#ffffff", "#ffe14d"];

export type Aspect = "16:9" | "9:16" | "1:1" | "4:5";
export const ASPECTS: { id: Aspect; name: string; hint: string }[] = [
  { id: "16:9", name: "Ngang 16:9", hint: "YouTube" }, { id: "9:16", name: "Dọc 9:16", hint: "TikTok, Reels" },
  { id: "1:1", name: "Vuông 1:1", hint: "Facebook, Instagram" }, { id: "4:5", name: "Dọc 4:5", hint: "Bài đăng Instagram" },
];
const SIZES: Record<Aspect, { W: number; H: number }> = { "16:9": { W: 1920, H: 1080 }, "9:16": { W: 1080, H: 1920 }, "1:1": { W: 1080, H: 1080 }, "4:5": { W: 1080, H: 1350 } };
export const outSize = (aspect: MapDoc["aspect"]) => SIZES[aspect] ?? SIZES["16:9"];

// ── colour ───────────────────────────────────────────────────────────────────
// the same log curves as scripts/mapcolor.py: log signal → scene linear → display with a soft highlight roll-off
const LOG: Record<Exclude<Delog, "none">, { inv: (y: number) => number; sat: number }> = {
  dlog: { inv: (y) => (y > 0.14 ? (10 ** ((y - 0.584555) / 0.256663) - 0.0108) / 0.9892 : (y - 0.0929) / 6.025), sat: 1.35 },
  dlogm: { inv: (y) => (y > 0.14 ? (10 ** ((y - 0.579) / 0.2472) - 0.0108) / 0.9892 : (y - 0.0929) / 6.025), sat: 1.25 },
  hlg: { inv: (y) => 3.75 * (y <= 0.5 ? (y * y) / 3 : (Math.exp((y - 0.55991073) / 0.17883277) + 0.28466892) / 12), sat: 1.2 },
};
const toDisplay = (x: number) => { const v = Math.max(0, x); return Math.min(1, (v * (1 + v / 16)) / (1 + v)) ** (1 / 2.2); };
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
export const isNeutral = (g?: Grade, skipDelog = false) =>
  !g || ((skipDelog || !g.delog || g.delog === "none") && !g.exposure && !g.contrast && !g.highlights && !g.shadows && !g.saturation && !g.temperature && !g.tint);

/** Per-channel curves (64 steps) and a saturation for a grade: delog → exposure → white balance → tone → saturation. */
export function gradeCurves(g: Grade, skipDelog = false) {
  const log = !skipDelog && g.delog && g.delog !== "none" ? LOG[g.delog] : null;
  const ev = 2 ** (g.exposure ?? 0), c = (g.contrast ?? 0) / 100, hi = (g.highlights ?? 0) / 100, sh = (g.shadows ?? 0) / 100;
  const t = (g.temperature ?? 0) / 100, m = (g.tint ?? 0) / 100;
  const gain = [1 + 0.12 * t + 0.04 * m, 1 - 0.08 * m, 1 - 0.12 * t + 0.04 * m];
  const curve = (ch: number) => Array.from({ length: 64 }, (_, i) => {
    let v = i / 63;
    if (log) v = toDisplay(log.inv(v));
    v = clamp01(v) ** 2.2 * ev * gain[ch];                       // exposure and white balance in linear light
    v = Math.min(1, v) ** (1 / 2.2);
    v += sh * 0.35 * 6.75 * v * (1 - v) ** 2 + hi * 0.35 * 6.75 * v * v * (1 - v);   // bumps peaking at ⅓ and ⅔
    v = 0.45 + (v - 0.45) * (1 + c * 0.8);
    return Number(clamp01(v).toFixed(4));
  });
  return { r: curve(0), g: curve(1), b: curve(2), sat: (log ? log.sat : 1) * (1 + (g.saturation ?? 0) / 100) };
}

/** The grade as an SVG filter; the video uses it with `filter: url(#id)`. */
export const GradeFilter: React.FC<{ id: string; grade: Grade; skipDelog?: boolean }> = ({ id, grade, skipDelog }) => {
  const k = useMemo(() => gradeCurves(grade, skipDelog), [JSON.stringify(grade), skipDelog]);
  const s = k.sat, L = [0.2126, 0.7152, 0.0722];
  const row = (i: number) => [0, 1, 2].map((j) => (1 - s) * L[j] + (i === j ? s : 0)).concat([0, 0]).join(" ");
  return (
    <svg width={0} height={0} style={{ position: "absolute" }} aria-hidden>
      <filter id={id} colorInterpolationFilters="sRGB" x="0" y="0" width="100%" height="100%">
        <feComponentTransfer>
          <feFuncR type="table" tableValues={k.r.join(" ")} />
          <feFuncG type="table" tableValues={k.g.join(" ")} />
          <feFuncB type="table" tableValues={k.b.join(" ")} />
        </feComponentTransfer>
        <feColorMatrix type="matrix" values={`${row(0)} ${row(1)} ${row(2)} 0 0 0 1 0`} />
      </filter>
    </svg>
  );
};

// ── geometry ─────────────────────────────────────────────────────────────────
const apply = (h: number[], x: number, y: number): Pt => { const w = h[6] * x + h[7] * y + h[8]; return [(h[0] * x + h[1] * y + h[2]) / w, (h[3] * x + h[4] * y + h[5]) / w]; };
export function invert(h: number[]): number[] {
  const [a, b, c, d, e, f, g, i, j] = h;
  const A = e * j - f * i, B = -(d * j - f * g), C = d * i - e * g, det = a * A + b * B + c * C;
  return [A, -(b * j - c * i), b * f - c * e, B, a * j - c * g, -(a * f - c * d), C, -(a * i - b * g), a * e - b * d].map((v) => v / det);
}
/** a polygon cut to the rectangle 0..W × 0..H (Sutherland–Hodgman) */
export function clipRect(poly: Pt[], W: number, H: number): Pt[] {
  const edges: [(p: Pt) => boolean, (a: Pt, b: Pt) => Pt][] = [
    [(p) => p[0] >= 0, (a, b) => [0, a[1] + ((b[1] - a[1]) * (0 - a[0])) / (b[0] - a[0])]],
    [(p) => p[0] <= W, (a, b) => [W, a[1] + ((b[1] - a[1]) * (W - a[0])) / (b[0] - a[0])]],
    [(p) => p[1] >= 0, (a, b) => [a[0] + ((b[0] - a[0]) * (0 - a[1])) / (b[1] - a[1]), 0]],
    [(p) => p[1] <= H, (a, b) => [a[0] + ((b[0] - a[0]) * (H - a[1])) / (b[1] - a[1]), H]],
  ];
  let out = poly;
  for (const [inside, cross] of edges) {
    const src = out; out = [];
    src.forEach((p, i) => {
      const q = src[(i + 1) % src.length];
      if (inside(p)) { out.push(p); if (!inside(q)) out.push(cross(p, q)); }
      else if (inside(q)) out.push(cross(p, q));
    });
  }
  return out;
}
export const polyLen = (p: Pt[]) => p.slice(1).reduce((s, q, i) => s + Math.hypot(q[0] - p[i][0], q[1] - p[i][1]), 0);
/** the point and heading at distance s along a polyline */
export function along(p: Pt[], s: number): { x: number; y: number; a: number } {
  for (let i = 0; i < p.length - 1; i++) {
    const L = Math.hypot(p[i + 1][0] - p[i][0], p[i + 1][1] - p[i][1]);
    if (s <= L || i === p.length - 2) {
      const k = L ? Math.min(1, Math.max(0, s / L)) : 0;
      return { x: p[i][0] + (p[i + 1][0] - p[i][0]) * k, y: p[i][1] + (p[i + 1][1] - p[i][1]) * k, a: Math.atan2(p[i + 1][1] - p[i][1], p[i + 1][0] - p[i][0]) };
    }
    s -= L;
  }
  return { x: p[0][0], y: p[0][1], a: 0 };
}
/** the first `len` of a polyline */
export function cut(p: Pt[], len: number): Pt[] {
  const out: Pt[] = [p[0]];
  for (let i = 0; i < p.length - 1; i++) {
    const L = Math.hypot(p[i + 1][0] - p[i][0], p[i + 1][1] - p[i][1]);
    if (len >= L) { out.push(p[i + 1]); len -= L; continue; }
    const k = L ? len / L : 0;
    out.push([p[i][0] + (p[i + 1][0] - p[i][0]) * k, p[i][1] + (p[i + 1][1] - p[i][1]) * k]);
    break;
  }
  return out;
}
export function smoothPath(p: Pt[]) {
  if (p.length < 2) return "";
  let d = `M${p[0][0]},${p[0][1]}`;
  for (let i = 0; i < p.length - 1; i++) {
    const p0 = p[Math.max(0, i - 1)], p1 = p[i], p2 = p[i + 1], p3 = p[Math.min(p.length - 1, i + 2)];
    d += ` C${p1[0] + (p2[0] - p0[0]) / 6},${p1[1] + (p2[1] - p0[1]) / 6} ${p2[0] - (p3[0] - p1[0]) / 6},${p2[1] - (p3[1] - p1[1]) / 6} ${p2[0]},${p2[1]}`;
  }
  return d;
}

/** the frames of the cut the video uses: [first, end) */
export const trimOf = (doc: Pick<MapDoc, "trim" | "H">): [number, number] => {
  const n = doc.H.length, a = Math.min(n - 1, Math.max(0, doc.trim?.[0] ?? 0));
  return [a, Math.min(n, Math.max(a + 1, doc.trim?.[1] ?? n))];
};
/** how many frames the video has, after the trim */
export const docFrames = (doc: Pick<MapDoc, "trim" | "H">) => { const [a, b] = trimOf(doc); return b - a; };

/**
 * Projection for a doc: first-frame fractions ↔ output pixels at frame f of the video (after the trim). The clip covers
 * the output and is scaled up by `zoom`; when it is bigger than the output, the window either follows the framing the
 * user dragged (`pan`, in x and y) or the highlights (in x): everything that is showing when it fits, else the newest
 * one, gliding from one to the next.
 */
export function useProjection(doc: MapDoc) {
  return useMemo(() => {
    const { W: OW, H: OH } = outSize(doc.aspect);
    const k = Math.max(OW / doc.srcW, OH / doc.srcH) * Math.max(1, doc.zoom ?? 1), videoW = doc.srcW * k, videoH = doc.srcH * k;
    const [t0] = trimOf(doc), n = docFrames(doc);
    const Hf = (f: number) => doc.H[t0 + Math.min(n - 1, Math.max(0, f))];
    const src = (f: number, p: Pt) => apply(Hf(f), p[0] * doc.srcW, p[1] * doc.srcH);
    const fitX = (c: number) => Math.min(videoW - OW, Math.max(0, c - OW / 2));
    const fitY = (c: number) => Math.min(videoH - OH, Math.max(0, c - OH / 2));
    let cropX = new Array(n).fill(Math.max(0, (videoW - OW) / 2));
    let cropY = new Array(n).fill(Math.max(0, (videoH - OH) / 2));
    // the user's framing keys, frames of the cut → frames of the video
    const keys = [...(doc.pan ?? [])].map((q) => ({ ...q, f: q.f - t0 })).sort((a, b) => a.f - b.f);
    if (keys.length) {
      // eased from one framing to the next, held before the first and after the last
      const at = Array.from({ length: n }, (_, f) => {
        const j = keys.findIndex((q) => q.f > f);
        const a = keys[j < 0 ? keys.length - 1 : Math.max(0, j - 1)], b = keys[j < 0 ? keys.length - 1 : j];
        const u = b.f > a.f ? Math.min(1, Math.max(0, (f - a.f) / (b.f - a.f))) : 0, e = u * u * (3 - 2 * u);
        return src(f, [a.pt[0] + (b.pt[0] - a.pt[0]) * e, a.pt[1] + (b.pt[1] - a.pt[1]) * e]);
      });
      cropX = at.map(([x]) => fitX(x * k));
      cropY = at.map(([, y]) => fitY(y * k));
    } else if (videoW > OW + 1) {
      // each highlight: the in-picture part of it, and when it comes in
      const marks: { pts: Pt[]; at: number }[] = [];
      for (const l of doc.layers) {
        if (l.hidden) continue;
        if (l.type === "area" || l.type === "building") marks.push({ pts: l.pts, at: l.in ?? 1.2 });
        else if (l.type === "pin" || l.type === "label" || l.type === "callout") marks.push({ pts: [l.pt], at: l.in ?? 1 });
        else if (l.type === "road" && l.name && l.nameStyle !== "none") marks.push({ pts: l.pts, at: l.in ?? 0.4 });
      }
      marks.sort((a, b) => a.at - b.at);
      if (marks.length) {
        const raw = Array.from({ length: n }, (_, f) => {
          const span = marks.map((mk) => {
            const xs = mk.pts.map((p) => src(f, p)[0] * k).filter((x) => x > 0 && x < videoW);
            const all = xs.length ? xs : mk.pts.map((p) => Math.min(videoW, Math.max(0, src(f, p)[0] * k)));
            return [Math.min(...all), Math.max(...all)];
          });
          // what is on screen by now (a little early, so the window is there when it appears)
          const t = f / doc.fps + 0.5;
          const shown = marks.map((mk, i) => (mk.at <= t ? i : -1)).filter((i) => i >= 0);
          const use = shown.length ? shown : [0];
          for (let a = 0; a < use.length; a++) {
            const pick = use.slice(a);
            const lo = Math.min(...pick.map((i) => span[i][0])), hi = Math.max(...pick.map((i) => span[i][1]));
            if (hi - lo < OW * 0.85 || a === use.length - 1) return (lo + hi) / 2;   // the newest alone may still be wider (a long road)
          }
          return videoW / 2;
        });
        // two box blurs of ~0.7 s: a cut between targets becomes an eased glide
        const blur = (a: number[], R: number) => a.map((_, f) => {
          let s = 0;
          for (let j = f - R; j <= f + R; j++) s += a[Math.min(n - 1, Math.max(0, j))];
          return s / (2 * R + 1);
        });
        cropX = blur(blur(raw.map(fitX), 10), 10);
      }
    }
    const ix = (f: number) => Math.min(n - 1, Math.max(0, f));
    const out = (f: number, p: Pt): Pt => { const [x, y] = src(f, p); return [x * k - cropX[ix(f)], y * k - cropY[ix(f)]]; };
    const inv = new Map<number, number[]>();
    /** output pixel at frame f → first-frame fraction (for the editor) */
    const back = (f: number, X: number, Y: number): Pt => {
      const ff = ix(f);
      if (!inv.has(ff)) inv.set(ff, invert(Hf(ff)));
      const [x, y] = apply(inv.get(ff)!, (X + cropX[ff]) / k, (Y + cropY[ff]) / k);
      return [x / doc.srcW, y / doc.srcH];
    };
    /** a pixel of the tracked frame at frame f → output pixels */
    const toOut = (f: number, [x, y]: Pt): Pt => [x * k - cropX[ix(f)], y * k - cropY[ix(f)]];
    return { OW, OH, k, videoW, videoH, cropX, cropY, out, back, n, t0, toOut, Hf };
  }, [doc]);
}

// ── lines ────────────────────────────────────────────────────────────────────
const lighten = (hex: string, a = 0.65) => {
  const n = parseInt(hex.slice(1), 16), c = (s: number) => Math.round(((n >> s) & 255) + (255 - ((n >> s) & 255)) * a);
  return `rgb(${c(16)},${c(8)},${c(0)})`;
};
const shade = (hex: string, k = 0.6) => {
  const n = parseInt(hex.slice(1), 16), c = (s: number) => Math.round(((n >> s) & 255) * k);
  return `rgb(${c(16)},${c(8)},${c(0)})`;
};

/** One road drawn in a style: `pts` in output pixels, `t` seconds, `t0` when it starts drawing on. */
export const LineArt: React.FC<{ pts: Pt[]; style: LineStyle; color: string; width?: number; speed?: number; t: number; t0?: number; id: string }> =
  ({ pts, style, color, width = 8, speed = 1, t, t0 = 0, id }) => {
    if (pts.length < 2) return null;
    const Lfull = polyLen(pts);
    const draw = interpolate(t, [t0, t0 + (style === "comet" ? 1.8 : 1.1)], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.out(Easing.quad) });
    if (draw <= 0) return null;
    const p = draw < 1 ? cut(pts, Lfull * draw) : pts;
    const d = smoothPath(p), L = polyLen(p);
    const core = lighten(color), w = width;
    const run = (t * 520 * speed) % (Lfull + 400);
    const glow = `mg-${id}`;
    const defs = <defs><filter id={glow} x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation={w * 0.9} /></filter></defs>;
    const flat: Record<string, LineStyle> = { surface: "ribbon", wall: "glow", trails: "neon", route: "comet", particles: "sparkle", gradient: "ribbon",
      markings: "double", wave: "pulse", grid: "double" };
    if (flat[style]) return <LineArt pts={pts} style={flat[style]} color={color} width={width} speed={speed} t={t} t0={t0} id={id} />;
    switch (style) {
      case "neon": {
        // a neon tube with pulses of light streaming along it (spaced by the line's width, so they show at any size)
        const pulse = Math.max(40, w * 7), gap = Math.max(220, w * 26), off = -(t * 650 * speed);
        const flick = 0.85 + 0.15 * Math.sin(t * 23) * Math.sin(t * 7);
        return <g>{defs}
          <path d={d} fill="none" stroke={color} strokeWidth={w * 2.6} opacity={0.55 * flick} filter={`url(#${glow})`} strokeLinecap="round" />
          <path d={d} fill="none" stroke={core} strokeWidth={w * 0.8} strokeLinecap="round" />
          <path d={d} fill="none" stroke={color} strokeWidth={w * 1.6} strokeLinecap="round" strokeDasharray={`${pulse * 1.6} ${gap - pulse * 0.6}`} strokeDashoffset={off + pulse * 0.3} filter={`url(#${glow})`} opacity={0.9} />
          <path d={d} fill="none" stroke="#fff" strokeWidth={w * 0.55} strokeLinecap="round" strokeDasharray={`${pulse} ${gap}`} strokeDashoffset={off} />
        </g>;
      }
      case "comet": {
        const head = along(p, L), loop = draw >= 1 ? along(pts, (t * 420 * speed) % Lfull) : null;
        return <g>{defs}
          <path d={d} fill="none" stroke={color} strokeWidth={w * 1.8} opacity={0.45} filter={`url(#${glow})`} strokeLinecap="round" />
          <path d={d} fill="none" stroke={core} strokeWidth={w * 0.8} strokeLinecap="round" />
          {draw < 1 ? <><circle cx={head.x} cy={head.y} r={w * 2.4} fill={color} opacity={0.6} filter={`url(#${glow})`} /><circle cx={head.x} cy={head.y} r={w * 1.1} fill="#fff" /></> : null}
          {loop ? <><circle cx={loop.x} cy={loop.y} r={w * 1.8} fill={color} opacity={0.6} filter={`url(#${glow})`} /><circle cx={loop.x} cy={loop.y} r={w * 0.8} fill="#fff" /></> : null}
        </g>;
      }
      case "arrows": {
        const gap = w * 9, off = (t * 160 * speed) % gap, marks = [];
        for (let s = off; s < L - w; s += gap) marks.push(along(p, s));
        return <g>{defs}
          <path d={d} fill="none" stroke={color} strokeWidth={w * 1.6} opacity={0.35} strokeLinecap="round" />
          {marks.map((m, i) => (
            <path key={i} d={`M ${-w * 1.2} ${-w * 1.3} L ${w * 0.9} 0 L ${-w * 1.2} ${w * 1.3}`} fill="none" stroke={core} strokeWidth={w * 0.7} strokeLinecap="round" strokeLinejoin="round"
              transform={`translate(${m.x} ${m.y}) rotate(${(m.a * 180) / Math.PI})`} />
          ))}
        </g>;
      }
      case "dashes":
        return <g>
          <path d={d} fill="none" stroke="rgba(0,0,0,0.35)" strokeWidth={w * 1.5} strokeLinecap="round" />
          <path d={d} fill="none" stroke={color} strokeWidth={w} strokeLinecap="round" strokeDasharray={`${w * 3} ${w * 2.2}`} strokeDashoffset={-(t * 60 * speed)} />
        </g>;
      case "dots":
        return <g>
          <path d={d} fill="none" stroke={color} strokeWidth={w * 1.2} strokeLinecap="round" strokeDasharray={`0.1 ${w * 2.6}`} strokeDashoffset={-(t * 40 * speed)} />
        </g>;
      case "ribbon":
        return <g>
          <path d={d} fill="none" stroke={color} strokeWidth={w * 5} opacity={0.42} strokeLinecap="butt" />
          <path d={d} fill="none" stroke={core} strokeWidth={w * 0.5} opacity={0.9} />
        </g>;
      case "outline":
        return <g>
          <path d={d} fill="none" stroke="#1d1d1f" strokeWidth={w * 2.2} strokeLinecap="round" />
          <path d={d} fill="none" stroke="#ffffff" strokeWidth={w * 1.6} strokeLinecap="round" />
          <path d={d} fill="none" stroke={color} strokeWidth={w} strokeLinecap="round" />
        </g>;
      case "laser": {
        const flick = 0.82 + 0.18 * Math.sin(t * 37) * Math.sin(t * 13);
        return <g>{defs}
          <path d={d} fill="none" stroke={color} strokeWidth={w * 1.4} opacity={0.5 * flick} filter={`url(#${glow})`} strokeLinecap="round" />
          <path d={d} fill="none" stroke={core} strokeWidth={w * 0.45} strokeLinecap="round" />
          <path d={d} fill="none" stroke="#fff" strokeWidth={w * 0.22} opacity={flick} strokeLinecap="round" />
          <path d={d} fill="none" stroke="#fff" strokeWidth={w * 0.9} strokeLinecap="round" strokeDasharray={`30 ${Lfull + 400}`} strokeDashoffset={-((t * 1400 * speed) % (Lfull + 400)) + 30} filter={`url(#${glow})`} />
        </g>;
      }
      case "pulse": {
        const beat = 0.5 + 0.5 * Math.sin(t * Math.PI * 2 * 0.9 * speed);
        return <g>{defs}
          <path d={d} fill="none" stroke={color} strokeWidth={w * (1.8 + 1.6 * beat)} opacity={0.25 + 0.45 * beat} filter={`url(#${glow})`} strokeLinecap="round" />
          <path d={d} fill="none" stroke={core} strokeWidth={w * 0.9} strokeLinecap="round" />
          <path d={d} fill="none" stroke="#fff" strokeWidth={w * 0.5} opacity={0.35 + 0.5 * beat} strokeLinecap="round" />
        </g>;
      }
      case "double": {
        const a = smoothPath(offsetLine(p, w * 0.9)), b = smoothPath(offsetLine(p, -w * 0.9));
        return <g>{defs}
          <path d={d} fill="none" stroke={color} strokeWidth={w * 2.4} opacity={0.16} strokeLinecap="round" />
          {[a, b].map((q, i) => <path key={i} d={q} fill="none" stroke={core} strokeWidth={w * 0.4} strokeLinecap="round" />)}
          {[a, b].map((q, i) => <path key={`r${i}`} d={q} fill="none" stroke="#fff" strokeWidth={w * 0.5} strokeLinecap="round" strokeDasharray={`70 ${Lfull + 400}`}
            strokeDashoffset={-((t * 700 * speed + i * 120) % (Lfull + 400)) + 70} filter={`url(#${glow})`} />)}
        </g>;
      }
      case "shimmer":
        // a gold line with light running over it in a few bands, like polished metal
        return <g>{defs}
          <path d={d} fill="none" stroke="#6b4a12" strokeWidth={w * 1.5} strokeLinecap="round" opacity={0.75} />
          <path d={d} fill="none" stroke={color} strokeWidth={w * 1.1} strokeLinecap="round" />
          {[0, 1, 2].map((i) => (
            <path key={i} d={d} fill="none" stroke={i === 1 ? "#fff" : "#fff3c4"} strokeWidth={w * (i === 1 ? 0.5 : 0.85)} opacity={i === 1 ? 0.95 : 0.55} strokeLinecap="round"
              strokeDasharray={`${w * (i === 1 ? 6 : 14)} ${w * 34}`} strokeDashoffset={-(t * 260 * speed) - i * w * 4} />
          ))}
        </g>;
      case "sparkle": {
        const n = Math.max(6, Math.floor(L / (w * 7)));
        return <g>{defs}
          <path d={d} fill="none" stroke={color} strokeWidth={w * 0.5} opacity={0.8} strokeLinecap="round" />
          {Array.from({ length: n }, (_, i) => {
            const s0 = noise(i, 1) * Lfull, v = 60 + 120 * noise(i, 2);
            const s1 = (s0 + t * v * speed) % Lfull;
            if (s1 > L) return null;
            const q = along(p, s1), tw = 0.5 + 0.5 * Math.sin(t * (6 + 6 * noise(i, 3)) + i), r = w * (0.25 + 0.45 * noise(i, 4)) * (0.6 + 0.6 * tw);
            return <g key={i} transform={`translate(${q.x} ${q.y})`} opacity={0.4 + 0.6 * tw}>
              <circle r={r * 2.4} fill={color} opacity={0.4} filter={`url(#${glow})`} />
              <path d={`M0 ${-r * 2.2} L${r * 0.45} 0 L0 ${r * 2.2} L${-r * 0.45} 0 Z M${-r * 2.2} 0 L0 ${r * 0.45} L${r * 2.2} 0 L0 ${-r * 0.45} Z`} fill="#fff" />
            </g>;
          })}
        </g>;
      }
      case "electric": {
        // the line again with a jitter that changes about 20 times a second
        const k = Math.floor(t * 20), dense: Pt[] = [];
        for (let s = 0; s <= L; s += Math.max(6, w * 1.5)) dense.push([along(p, s).x, along(p, s).y]);
        const bolt = (seed: number, amp: number) => smoothPath(dense.map((q, i) => {
          const a = along(p, Math.min(L, i * Math.max(6, w * 1.5))).a, j = (noise(i, k + seed) - 0.5) * amp;
          return [q[0] - Math.sin(a) * j, q[1] + Math.cos(a) * j] as Pt;
        }));
        return <g>{defs}
          <path d={d} fill="none" stroke={color} strokeWidth={w * 2} opacity={0.35} filter={`url(#${glow})`} strokeLinecap="round" />
          <path d={bolt(7, w * 2.2)} fill="none" stroke={core} strokeWidth={w * 0.5} strokeLinejoin="round" />
          <path d={bolt(19, w * 1.4)} fill="none" stroke="#fff" strokeWidth={w * 0.3} strokeLinejoin="round" opacity={0.9} />
        </g>;
      }
      case "tube": {
        // a raised tube: a shadow below, the body, a light line along its top
        const sh = smoothPath(p.map(([x, y]) => [x + w * 0.5, y + w * 0.9] as Pt)), top = smoothPath(offsetLine(p, w * 0.35).map(([x, y]) => [x, y - w * 0.15] as Pt));
        return <g>
          <path d={sh} fill="none" stroke="rgba(0,0,0,0.4)" strokeWidth={w * 1.6} strokeLinecap="round" />
          <path d={d} fill="none" stroke={shade(color, 0.55)} strokeWidth={w * 1.6} strokeLinecap="round" />
          <path d={d} fill="none" stroke={color} strokeWidth={w * 1.15} strokeLinecap="round" />
          <path d={top} fill="none" stroke="rgba(255,255,255,0.75)" strokeWidth={w * 0.32} strokeLinecap="round" />
          <path d={d} fill="none" stroke="#fff" strokeWidth={w * 0.6} strokeLinecap="round" opacity={0.7} strokeDasharray={`${w * 4} ${Lfull + 400}`} strokeDashoffset={-run + w * 4} />
        </g>;
      }
      default: // glow
        return <g>{defs}
          <path d={d} fill="none" stroke={color} strokeWidth={w * 2.2} opacity={0.85} filter={`url(#${glow})`} strokeLinecap="round" />
          <path d={d} fill="none" stroke={core} strokeWidth={w} strokeLinecap="round" />
          <path d={d} fill="none" stroke="#fff" strokeWidth={w * 0.8} opacity={0.6 * draw} strokeLinecap="round" strokeDasharray={`140 ${Lfull + 400}`} strokeDashoffset={-run + 140} />
        </g>;
    }
  };

// ── names ────────────────────────────────────────────────────────────────────
/** Where a road's name sits in the first frame: a quad along the road, starting a little way into the picture. */
export function nameQuad(pts: Pt[], text: string, srcW: number, srcH: number, h = 34): Pt[] | null {
  const px: Pt[] = pts.map(([x, y]) => [x * srcW, y * srcH]);
  const inside = px.findIndex(([x, y]) => x > 40 && x < srcW - 40 && y > 40 && y < srcH - 40);
  const s0 = inside < 0 ? 150 : polyLen(px.slice(0, inside + 1)) + 60;
  const L = 0.62 * text.length * h, total = polyLen(px);
  const start = Math.max(20, Math.min(s0, total - L - 20));
  if (total < L + 40) return null;
  let a = along(px, start), b = along(px, start + L);
  let v: Pt = [b.x - a.x, b.y - a.y];
  const n = Math.hypot(v[0], v[1]) || 1;
  v = [v[0] / n, v[1] / n];
  if (v[0] < -0.1 || (Math.abs(v[0]) <= 0.1 && v[1] > 0)) { [a, b] = [b, a]; v = [-v[0], -v[1]]; }
  const up: Pt = [v[1], -v[0]], g = 12;
  const BL: Pt = [a.x + up[0] * g, a.y + up[1] * g], BR: Pt = [b.x + up[0] * g, b.y + up[1] * g];
  return [[BL[0] + up[0] * h, BL[1] + up[1] * h], [BR[0] + up[0] * h, BR[1] + up[1] * h], BR, BL].map(([x, y]) => [x / srcW, y / srcH] as Pt);
}

const NameTag: React.FC<{ text: string; x: number; y: number; style: "pill" | "sign"; color: string; t: number; at: number }> = ({ text, x, y, style, color, t, at }) => {
  const k = interpolate(t, [at, at + 0.5], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.out(Easing.back(1.5)) });
  if (k <= 0) return null;
  if (style === "sign") {
    return (
      <div style={{ position: "absolute", left: x, top: y, transform: `translate(-50%, -100%) scale(${k})`, transformOrigin: "50% 100%" }}>
        <div style={{ background: "#1f7a46", border: "4px solid #fff", borderRadius: 8, padding: "6px 20px", fontFamily: FONT, fontWeight: 800, fontSize: 30,
          color: "#fff", whiteSpace: "nowrap", boxShadow: "0 6px 14px rgba(0,0,0,0.35)" }}>{text}</div>
        <div style={{ width: 6, height: 46, margin: "0 auto", background: "#cfd4d8", borderLeft: "1px solid #888" }} />
      </div>
    );
  }
  return (
    <div style={{ position: "absolute", left: x, top: y, transform: `translate(-50%, -130%) scale(${k})`, padding: "6px 20px", borderRadius: 999, whiteSpace: "nowrap",
      background: "rgba(16,18,22,0.78)", border: `3px solid ${color}`, color: "#fff", fontFamily: FONT, fontWeight: 800, fontSize: 28, boxShadow: `0 0 16px ${color}` }}>{text}</div>
  );
};

// ── the composition ──────────────────────────────────────────────────────────
/** The 3D camera of each frame (for buildings), from the fitted ground and the track; null without a ground fit. */
export function useCameras(doc: MapDoc, P: ReturnType<typeof useProjection>) {
  return useMemo(() => {
    if (!doc.ground || doc.ground.length !== 9) return null;
    const G = (f: number) => mul9(P.Hf(f), doc.ground!);
    const step = Math.max(1, Math.floor(P.n / 12));
    const fpx = focalOf(Array.from({ length: Math.ceil(P.n / step) }, (_, i) => G(i * step)), doc.srcW / 2, doc.srcH / 2);
    const cache = new Map<number, Cam>();
    const toGround = inv9(doc.ground);
    return {
      at: (f: number) => { if (!cache.has(f)) cache.set(f, camOf(G(f), fpx, doc.srcW / 2, doc.srcH / 2)); return cache.get(f)!; },
      /** first-frame fractions → map metres */
      metres: (p: Pt): Pt => applyH(toGround, p[0] * doc.srcW, p[1] * doc.srcH),
    };
  }, [doc.ground, P]);
}

/** The ground spot (first-frame fractions) a road's pill / sign is pinned to, so it rides with the road instead of
 *  sliding as the picture moves: the user's `nameAt`, else the middle of what is in the window when it appears. */
export function nameSpot(r: RoadLayer, P: ReturnType<typeof useProjection>, fps: number): Pt | null {
  if (r.pts.length < 2) return r.pts[0] ?? null;
  if (r.nameAt !== undefined) { const a = along(r.pts, polyLen(r.pts) * r.nameAt); return [a.x, a.y]; }
  const f = Math.min(P.n - 1, Math.max(0, Math.round(((r.in ?? 0.4) + 0.8) * fps)));
  const inside = r.pts.map((p, i) => [P.out(f, p), i] as const).filter(([[x, y]]) => x > 120 && x < P.OW - 120 && y > 120 && y < P.OH - 60);
  return inside.length ? r.pts[inside[Math.floor(inside.length / 2)][1]] : r.pts[Math.floor(r.pts.length / 2)];
}

/** `split` (editor only): the ungraded clip shown left of that fraction of the width, for before / after. */
export const MapShot: React.FC<{ doc?: MapDoc; map?: string; split?: number | null }> = ({ doc, split }) => {
  if (!doc) return <AbsoluteFill style={{ backgroundColor: "#111" }} />;
  return <MapShotInner doc={doc} split={split ?? null} />;
};

const MapShotInner: React.FC<{ doc: MapDoc; split: number | null }> = ({ doc, split }) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const P = useProjection(doc);
  const f = Math.min(frame, P.n - 1), t = frame / fps;
  const quads = useMemo(() => Object.fromEntries(doc.layers.filter((l): l is RoadLayer => l.type === "road" && !!l.name && (l.nameStyle ?? "along") === "along")
    .map((l) => [l.id, nameQuad(l.pts, l.name!.toUpperCase(), doc.srcW, doc.srcH)])), [doc]);
  const vis = doc.layers.filter((l) => !l.hidden);
  const cams = useCameras(doc, P);
  const tagSpots = useMemo(() => Object.fromEntries(doc.layers.filter((l): l is RoadLayer => l.type === "road").map((r) => [r.id, nameSpot(r, P, doc.fps)])), [doc, P]);
  const graded = !isNeutral(doc.grade, liveDelogOff(doc));
  // the buildings of this frame on screen: real ones hide the ground layers and the new buildings behind them
  const blds = cams ? vis.filter((l): l is BuildingLayer => l.type === "building").map((bl) => {
    const foot = bl.pts.map(cams.metres), cam = cams.at(f);
    return { bl, foot, sil: silhouette(foot, bl.height, cam, (p) => P.toOut(f, p)) };
  }) : [];
  // buildings followed by SAM 2: their real outline this frame
  const segLayers = vis.filter((l): l is SegLayer => l.type === "seg");
  const segs = useSegs(segLayers.map((l) => l.src));
  const segToOut = (p: Pt) => P.toOut(f, p);
  const holes = [...blds.filter((b) => b.bl.real && b.sil).map((b) => b.sil!.hull),
    ...segLayers.filter((l) => l.occlude !== false).flatMap((l) => segPolys(segs[l.src], f + P.t0, segToOut))];
  const holesBefore = (depth: number) => blds.filter((b) => b.bl.real && b.sil && b.sil.depth < depth).map((b) => b.sil!.hull);
  const file = (c: string) => (c.startsWith("http") ? c : staticFile(c));
  return (
    <AbsoluteFill style={{ backgroundColor: "#0a0c10", overflow: "hidden" }}>
      {graded ? <GradeFilter id="mapgrade" grade={doc.grade!} skipDelog={liveDelogOff(doc)} /> : null}
      {/* in the editor's player, keep the picture within ~3 frames of the layers drawn on it (the render is exact anyway) */}
      <OffthreadVideo src={file(doc.clip)} muted acceptableTimeShiftInSeconds={0.1} trimBefore={P.t0 || undefined}
        style={{ position: "absolute", top: -P.cropY[f], left: -P.cropX[f], width: P.videoW, height: P.videoH, maxWidth: "none", filter: graded ? "url(#mapgrade)" : undefined }} />
      {split !== null ? (
        <div style={{ position: "absolute", inset: 0, clipPath: `inset(0 ${(1 - split) * 100}% 0 0)` }}>
          <OffthreadVideo src={file(doc.source ?? doc.clip)} muted acceptableTimeShiftInSeconds={0.1} trimBefore={P.t0 || undefined} style={{ position: "absolute", top: -P.cropY[f], left: -P.cropX[f], width: P.videoW, height: P.videoH, maxWidth: "none" }} />
        </div>
      ) : null}
      <Occlude holes={holes} W={P.OW} H={P.OH}>
      {vis.filter((l): l is AreaLayer => l.type === "area").map((a) => (
        <Area key={a.id} uid={a.id} a={{ label: null, in: a.in ?? 1.2, lift: 40, color: a.color, pts: [a.pts.map((p) => P.out(f, p))] }} f={0} t={t} W={P.OW} H={P.OH} />
      ))}
      <svg width={P.OW} height={P.OH} style={{ position: "absolute", inset: 0, overflow: "visible" }}>
        {vis.filter((l): l is RoadLayer => l.type === "road").map((r, i) => cams && isRoad3D(r.style) ? (
          <Road3D key={r.id} id={r.id} foot={r.pts.map(cams.metres)} cam={cams.at(f)} toOut={(p) => P.toOut(f, p)} style={r.style} color={r.color}
            width={(r.width ?? 8) * ROAD_M} speed={r.speed} t={t} t0={r.in ?? 0.4 + i * 0.15} W={P.OW} H={P.OH} />
        ) : (
          <LineArt key={r.id} id={r.id} pts={r.pts.map((p) => P.out(f, p))} style={r.style} color={r.color} width={r.width} speed={r.speed} t={t} t0={r.in ?? 0.4 + i * 0.15} />
        ))}
      </svg>
      {vis.filter((l): l is RoadLayer => l.type === "road" && !!l.name && (l.nameStyle ?? "along") === "along").map((r, i) => {
        const q = quads[r.id];
        return q ? <RoadLabel key={`${r.id}-${frame}`} id={i + 100} text={r.name!.toUpperCase()} quad={q.map((p) => P.out(f, p))} t={t} at={(r.in ?? 0.4) + 0.7} /> : null;
      })}
      {vis.filter((l): l is TextLayer => l.type === "label").map((l, i) => {
        const h = (l.size ?? 70) / doc.srcH, w = (h * doc.srcH * 0.62 * l.text.length) / doc.srcW;
        const q: Pt[] = [[l.pt[0] - w / 2, l.pt[1] - h / 2], [l.pt[0] + w / 2, l.pt[1] - h / 2], [l.pt[0] + w / 2, l.pt[1] + h / 2], [l.pt[0] - w / 2, l.pt[1] + h / 2]];
        return <GroundLabel key={`${l.id}-${frame}`} id={i + 200} lines={[l.text.toUpperCase()]} quad={q.map((p) => P.out(f, p))} t={t} at={l.in ?? 1} />;
      })}
      </Occlude>
      {/* new buildings, far ones first, each hidden behind the real buildings in front of it */}
      {cams ? blds.filter((b) => !b.bl.real && b.sil).sort((a, b) => b.sil!.depth - a.sil!.depth).map(({ bl, foot, sil }) => (
        <Occlude key={bl.id} holes={holesBefore(sil!.depth)} W={P.OW} H={P.OH}>
          <Building cam={cams.at(f)} toOut={(p) => P.toOut(f, p)} t={t} W={P.OW} H={P.OH}
            b={{ id: bl.id, foot, height: bl.height, glass: bl.glass, image: bl.image, imgW: bl.imgW, imgH: bl.imgH, imgQuad: bl.imgQuad, front: bl.front, wrap: bl.wrap, at: bl.in ?? 1 }} />
        </Occlude>
      )) : null}
      {doc.look === "gold" ? <Haze t={t} dur={durationInFrames / fps} /> : doc.look === "mint" ? <Leaks t={t} dur={durationInFrames / fps} /> : null}
      {segLayers.map((l) => segs[l.src] && l.hl ? (
        <SegHighlight key={l.id} id={l.id} d={segs[l.src]!} f={f + P.t0} toOut={segToOut} t={t} at={l.in ?? 0.6} fx={l.hl!.fx} color={l.hl!.color}
          label={l.hl!.label} dim={l.dim} W={P.OW} H={P.OH} />
      ) : null)}
      {/* highlighted buildings (real ones mostly), each still behind the real buildings in front of it */}
      {cams ? blds.filter((b) => b.bl.hl && b.sil).sort((a, b) => b.sil!.depth - a.sil!.depth).map(({ bl, foot, sil }) => (
        <Occlude key={`hl-${bl.id}`} holes={holesBefore(sil!.depth)} W={P.OW} H={P.OH}>
          <Highlight id={bl.id} foot={foot} height={bl.height} cam={cams.at(f)} toOut={(p) => P.toOut(f, p)} t={t} at={bl.in ?? 1}
            fx={bl.hl!.fx} color={bl.hl!.color} label={bl.hl!.label} W={P.OW} H={P.OH} />
        </Occlude>
      )) : null}
      {vis.filter((l): l is RoadLayer => l.type === "road" && !!l.name && (l.nameStyle === "pill" || l.nameStyle === "sign")).map((r) => {
        const pt = tagSpots[r.id];
        if (!pt) return null;
        const [x, y] = P.out(f, pt);
        return <NameTag key={r.id} text={r.name!} x={x} y={y} style={r.nameStyle as "pill" | "sign"} color={r.color} t={t} at={(r.in ?? 0.4) + 0.8} />;
      })}
      {vis.filter((l): l is PinLayer => l.type === "pin").map((p) => <Pin key={p.id} text={p.text} p={P.out(f, p.pt)} t={t} at={p.in ?? 1} />)}
      {vis.filter((l): l is CalloutLayer => l.type === "callout").map((c) => {
        const p = P.out(f, c.pt);
        return <Callout key={c.id} title={c.title} sub={c.sub} icon={c.icon} p={p} t={t} at={c.in ?? 1} flip={p[0] + calloutWidth(c.title, c.sub) > P.OW - 24} />;
      })}
      {vis.filter((l): l is AreaLayer => l.type === "area" && !!l.label).map((a) => {
        // over the part of the area that is in the picture, not its off-screen corners
        const pts = clipRect(a.pts.map((p) => P.out(f, p)), P.OW, P.OH);
        if (pts.length < 3) return null;
        const half = (a.label!.length * 0.66 * 46 + 70) / 2 + 24;
        let A = 0, cx = 0, cy = 0;
        pts.forEach((p, i) => { const q = pts[(i + 1) % pts.length], c = p[0] * q[1] - q[0] * p[1]; A += c; cx += (p[0] + q[0]) * c; cy += (p[1] + q[1]) * c; });
        if (Math.abs(A) < 1) return null;
        const x = Math.min(P.OW - half, Math.max(half, cx / (3 * A)));
        // centred on the area (the tag hangs above its anchor point)
        return <AreaTag key={a.id} text={a.label!} x={x} y={Math.max(90, Math.min(P.OH - 200, cy / (3 * A) + 40))} t={t} at={(a.in ?? 1.2) + 0.6} />;
      })}
      {doc.title ? <Title text={doc.title} t={t} at={0.8} /> : null}
      {doc.credit ? <div style={{ position: "absolute", right: 24, bottom: 16, fontFamily: FONT, fontSize: 20, color: "rgba(255,255,255,0.8)", textShadow: "0 1px 3px rgba(0,0,0,0.7)" }}>{doc.credit}</div> : null}
    </AbsoluteFill>
  );
};
