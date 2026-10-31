/**
 * A 3D building stood on the ground of an aerial clip. The camera of every frame comes from the ground track: the
 * map (metres) → frame homography of a flat ground is K·[r1 r2 t] for a pinhole camera, so with the focal length
 * (found from the same homographies) the full pose falls out, and points above the ground can be projected too.
 * The building is a prism on a footprint: its walls are textured quads (CSS matrix3d, so the facade image keeps
 * its perspective), the roof a polygon, the shadow a soft patch on the ground; it rises out of the ground when it appears.
 */
import React from "react";
import { Easing, Img, interpolate, staticFile } from "remotion";
import { AreaTag } from "../tracked/TrackedShot";

type Pt = [number, number];
type V3 = [number, number, number];
type M9 = number[];

// ── small linear algebra ─────────────────────────────────────────────────────
const mul = (a: M9, b: M9): M9 => [0, 1, 2].flatMap((i) => [0, 1, 2].map((j) => a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j]));
const app = (h: M9, x: number, y: number): Pt => { const w = h[6] * x + h[7] * y + h[8]; return [(h[0] * x + h[1] * y + h[2]) / w, (h[3] * x + h[4] * y + h[5]) / w]; };
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const scale = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const norm = (a: V3) => scale(a, 1 / (Math.hypot(...a) || 1));
export function inv9(h: M9): M9 {
  const [a, b, c, d, e, f, g, i, j] = h;
  const A = e * j - f * i, B = -(d * j - f * g), C = d * i - e * g, det = a * A + b * B + c * C;
  return [A, -(b * j - c * i), b * f - c * e, B, a * j - c * g, -(a * f - c * d), C, -(a * i - b * g), a * e - b * d].map((v) => v / det);
}

/** the homography taking 4 points to 4 points (row-major, h8 = 1) */
export function quadH(src: Pt[], dst: Pt[]): M9 {
  const A: number[][] = [];
  for (let k = 0; k < 4; k++) {
    const [x, y] = src[k], [u, v] = dst[k];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u]);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y, v]);
  }
  for (let c = 0; c < 8; c++) {   // Gauss–Jordan with partial pivoting
    let p = c;
    for (let r = c + 1; r < 8; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]];
    for (let r = 0; r < 8; r++) {
      if (r === c) continue;
      const k = A[r][c] / A[c][c];
      for (let q = c; q < 9; q++) A[r][q] -= k * A[c][q];
    }
  }
  return [...A.map((r, i) => r[8] / r[i]), 1];
}
/** a CSS transform that puts an element's (0,0)…(w,h) box onto a screen quad [tl, tr, br, bl] */
const css3d = (h: M9) => `matrix3d(${h[0]},${h[3]},0,${h[6]},${h[1]},${h[4]},0,${h[7]},0,0,1,0,${h[2]},${h[5]},0,${h[8]})`;
const boxTo = (w: number, h: number, quad: Pt[]) => css3d(quadH([[0, 0], [w, 0], [w, h], [0, h]], quad));

// ── the camera ───────────────────────────────────────────────────────────────
/** focal length (px) from ground homographies: the image of the plane's axes must be at right angles and alike in length */
export function focalOf(Gs: M9[], cx: number, cy: number): number {
  const out: number[] = [];
  for (const G of Gs) {
    const g = mul([1, 0, -cx, 0, 1, -cy, 0, 0, 1], G);
    const h1 = [g[0], g[3], g[6]], h2 = [g[1], g[4], g[7]];
    const d1 = h1[2] * h2[2], d2 = h1[2] ** 2 - h2[2] ** 2;
    if (Math.abs(d1) > 1e-12) { const f2 = -(h1[0] * h2[0] + h1[1] * h2[1]) / d1; if (f2 > 0) out.push(Math.sqrt(f2)); }
    if (Math.abs(d2) > 1e-12) { const f2 = -(h1[0] ** 2 + h1[1] ** 2 - h2[0] ** 2 - h2[1] ** 2) / d2; if (f2 > 0) out.push(Math.sqrt(f2)); }
  }
  out.sort((a, b) => a - b);
  return out.length ? out[Math.floor(out.length / 2)] : cx / Math.tan((35 * Math.PI) / 180);   // else a 70° lens
}

export type Cam = { f: number; cx: number; cy: number; r1: V3; r2: V3; r3: V3; t: V3; up: number; C: V3 };
/** the pose for one frame from its map metres → frame pixels homography */
export function camOf(G: M9, f: number, cx: number, cy: number): Cam {
  const Ki = [1 / f, 0, -cx / f, 0, 1 / f, -cy / f, 0, 0, 1], B = mul(Ki, G);
  const b1: V3 = [B[0], B[3], B[6]], b2: V3 = [B[1], B[4], B[7]], b3: V3 = [B[2], B[5], B[8]];
  let lam = 2 / (Math.hypot(...b1) + Math.hypot(...b2));
  if (b3[2] * lam < 0) lam = -lam;   // the ground in front of the camera
  const r1 = norm(scale(b1, lam)), r2raw = scale(b2, lam);
  const r2 = norm(sub(r2raw, scale(r1, dot(r1, r2raw))));
  const r3 = cross(r1, r2), t = scale(b3, lam);
  // camera centre −Rᵀt; the side of the ground it is on is "up" (map y points south, so it can be −z)
  const C: V3 = scale([dot([r1[0], r2[0], r3[0]], t), dot([r1[1], r2[1], r3[1]], t), dot([r1[2], r2[2], r3[2]], t)], -1);
  return { f, cx, cy, r1, r2, r3, t, up: C[2] >= 0 ? 1 : -1, C };
}
/** a point (map metres, height in metres) → frame pixels and its depth */
export function camProject(c: Cam, x: number, y: number, z: number): { p: Pt; depth: number } {
  const Z = z * c.up;
  const X: V3 = [c.r1[0] * x + c.r2[0] * y + c.r3[0] * Z + c.t[0], c.r1[1] * x + c.r2[1] * y + c.r3[1] * Z + c.t[1], c.r1[2] * x + c.r2[2] * y + c.r3[2] * Z + c.t[2]];
  return { p: [c.cx + (c.f * X[0]) / X[2], c.cy + (c.f * X[1]) / X[2]], depth: X[2] };
}
export { app as applyH, mul as mul9 };

// ── the building ─────────────────────────────────────────────────────────────
export type Glass = "blue" | "gold" | "white";
export const GLASS: { id: Glass; name: string }[] = [{ id: "blue", name: "Kính xanh" }, { id: "gold", name: "Kính ánh vàng" }, { id: "white", name: "Tường trắng" }];
const SKIN: Record<Glass, { face: string; grid: string; roof: string }> = {
  blue: { face: "linear-gradient(180deg, #8fb4cf 0%, #4b7391 45%, #24435a 100%)", grid: "rgba(12,24,34,0.55)", roof: "#3a4652" },
  gold: { face: "linear-gradient(180deg, #e8cf9c 0%, #a98552 50%, #5b4024 100%)", grid: "rgba(40,24,8,0.5)", roof: "#4a4036" },
  white: { face: "linear-gradient(180deg, #f2efe8 0%, #d9d4ca 60%, #b9b2a6 100%)", grid: "rgba(70,74,80,0.45)", roof: "#8d8b86" },
};
const PX_M = 8; // texture pixels per metre on the plain walls

export type BuildingSpec = {
  id: string; foot: Pt[]; height: number; glass?: Glass; image?: string; imgW?: number; imgH?: number;
  imgQuad?: Pt[]; front?: number; wrap?: boolean; at: number;
};

/** the wall whose outside looks most toward the camera (weighted by its width): where the facade image goes by default */
export function frontWall(foot: Pt[], cam: Cam): number {
  const cxm = foot.reduce((s, p) => s + p[0], 0) / foot.length, cym = foot.reduce((s, p) => s + p[1], 0) / foot.length;
  let best = 0, bv = -Infinity;
  foot.forEach((a, i) => {
    const b = foot[(i + 1) % foot.length], mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
    let n: Pt = [b[1] - a[1], -(b[0] - a[0])];
    if (n[0] * (mx - cxm) + n[1] * (my - cym) < 0) n = [-n[0], -n[1]];
    const v = n[0] * (cam.C[0] - mx) + n[1] * (cam.C[1] - my);
    if (v > bv) { bv = v; best = i; }
  });
  return best;
}

export const Building: React.FC<{ b: BuildingSpec; cam: Cam; toOut: (p: Pt) => Pt; t: number; W: number; H: number }> = ({ b, cam, toOut, t, W, H }) => {
  const rise = interpolate(t, [b.at, b.at + 1.6], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.inOut(Easing.cubic) });
  if (rise <= 0 || b.foot.length < 3) return null;
  const h = Math.max(0.5, b.height * rise), skin = SKIN[b.glass ?? "blue"];
  const n = b.foot.length;
  const cxm = b.foot.reduce((s, p) => s + p[0], 0) / n, cym = b.foot.reduce((s, p) => s + p[1], 0) / n;
  const P = (x: number, y: number, z: number) => { const r = camProject(cam, x, y, z); return { p: toOut(r.p), depth: r.depth }; };
  const front = b.front ?? frontWall(b.foot, cam);
  // the walls that face the camera, far ones first
  const walls = b.foot.map((a, i) => {
    const c = b.foot[(i + 1) % n], mx = (a[0] + c[0]) / 2, my = (a[1] + c[1]) / 2;
    let nx = c[1] - a[1], ny = -(c[0] - a[0]);
    if (nx * (mx - cxm) + ny * (my - cym) < 0) { nx = -nx; ny = -ny; }
    const seen = nx * (cam.C[0] - mx) + ny * (cam.C[1] - my) > 0;
    const q = [P(a[0], a[1], 0), P(c[0], c[1], 0), P(c[0], c[1], h), P(a[0], a[1], h)];
    // light from the south-east: walls turned to it are brighter
    const lit = 0.5 + 0.5 * ((nx * 0.6 + ny * 0.8) / (Math.hypot(nx, ny) || 1));
    return { i, q, seen, len: Math.hypot(c[0] - a[0], c[1] - a[1]), depth: q.reduce((s, v) => s + v.depth, 0) / 4, lit };
  }).filter((w) => w.seen && w.q.every((v) => v.depth > 1)).sort((a, c) => c.depth - a.depth);
  const top = b.foot.map((p) => P(p[0], p[1], h)).filter((v) => v.depth > 1).map((v) => v.p);
  // shadow: the footprint and the footprint pushed away from the sun, joined (convex hull), on the ground
  const sh: Pt[] = hull([...b.foot, ...b.foot.map(([x, y]): Pt => [x - 0.55 * h, y - 0.35 * h])]).map(([x, y]) => P(x, y, 0)).filter((v) => v.depth > 1).map((v) => v.p);
  const poly = (pts: Pt[]) => pts.map((p) => p.join(",")).join(" ");
  return (
    <div style={{ position: "absolute", inset: 0, overflow: "hidden", pointerEvents: "none" }}>
      <svg width={W} height={H} style={{ position: "absolute", inset: 0 }}>
        <defs><filter id={`bsh-${b.id}`} x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="10" /></filter></defs>
        {sh.length > 2 ? <polygon points={poly(sh)} fill="rgba(0,0,0,0.42)" filter={`url(#bsh-${b.id})`} /> : null}
      </svg>
      {walls.map((w) => {
        // left / right as the camera sees the wall, so the image is never mirrored
        const [b0, b1, t1, t0] = w.q.map((v) => v.p);
        const flip = b1[0] < b0[0];
        const quad: Pt[] = flip ? [t1, t0, b0, b1] : [t0, t1, b1, b0];   // tl, tr, br, bl
        const withImage = b.image && b.imgW && b.imgH && (b.wrap || w.i === front);
        const tw = Math.max(1, w.len * PX_M), th = Math.max(1, h * PX_M);
        const shade = `rgba(0,0,0,${(0.42 * (1 - w.lit)).toFixed(3)})`;
        return (
          <React.Fragment key={w.i}>
            {withImage ? (
              // the chosen part of the image (imgQuad) onto the wall, clipped to the wall
              <div style={{ position: "absolute", inset: 0, clipPath: `polygon(${quad.map((p) => `${p[0]}px ${p[1]}px`).join(",")})` }}>
                <Img src={b.image!.startsWith("http") ? b.image! : staticFile(b.image!)} style={{
                  position: "absolute", left: 0, top: 0, width: b.imgW, height: b.imgH, maxWidth: "none", transformOrigin: "0 0",
                  transform: css3d(quadH((b.imgQuad ?? [[0, 0], [1, 0], [1, 1], [0, 1]]).map(([u, v]): Pt => [u * b.imgW!, v * b.imgH!]), quad)),
                }} />
              </div>
            ) : (
              <div style={{
                position: "absolute", left: 0, top: 0, width: tw, height: th, transformOrigin: "0 0", transform: boxTo(tw, th, quad),
                background: `repeating-linear-gradient(0deg, ${skin.grid} 0 2px, transparent 2px ${3.3 * PX_M}px), repeating-linear-gradient(90deg, ${skin.grid} 0 1.5px, transparent 1.5px ${1.6 * PX_M}px), ${skin.face}`,
              }} />
            )}
            <div style={{ position: "absolute", inset: 0, clipPath: `polygon(${quad.map((p) => `${p[0]}px ${p[1]}px`).join(",")})`, background: shade }} />
          </React.Fragment>
        );
      })}
      <svg width={W} height={H} style={{ position: "absolute", inset: 0 }}>
        {top.length > 2 ? <polygon points={poly(top)} fill={skin.roof} stroke="rgba(255,255,255,0.55)" strokeWidth={1.5} /> : null}
        {/* a light edge on the top while it rises */}
        {top.length > 2 && rise < 1 ? <polygon points={poly(top)} fill="none" stroke="#ffe4a0" strokeWidth={3} opacity={1 - rise} /> : null}
      </svg>
    </div>
  );
};

/** where a prism (footprint in metres, height) is on screen: its outline (convex hull of the corners), or null when it
 *  is behind the camera; with its depth, to tell which of two buildings is in front */
export function silhouette(foot: Pt[], height: number, cam: Cam, toOut: (p: Pt) => Pt): { hull: Pt[]; depth: number } | null {
  const pts = [...foot.map(([x, y]) => camProject(cam, x, y, 0)), ...foot.map(([x, y]) => camProject(cam, x, y, height))];
  if (pts.some((v) => v.depth <= 1)) return null;
  return { hull: hull(pts.map((v) => toOut(v.p))), depth: pts.reduce((s, v) => s + v.depth, 0) / pts.length };
}
/** the edges of a prism on screen (base, top, uprights), for the editor's wireframe */
export function prismEdges(foot: Pt[], height: number, cam: Cam, toOut: (p: Pt) => Pt): [Pt, Pt][] {
  const lo = foot.map(([x, y]) => camProject(cam, x, y, 0)), hi = foot.map(([x, y]) => camProject(cam, x, y, height));
  const out: [Pt, Pt][] = [];
  foot.forEach((_, i) => {
    const j = (i + 1) % foot.length;
    for (const [a, b] of [[lo[i], lo[j]], [hi[i], hi[j]], [lo[i], hi[i]]]) if (a.depth > 1 && b.depth > 1) out.push([toOut(a.p), toOut(b.p)]);
  });
  return out;
}

/**
 * Hide what is inside the given screen outlines (real buildings standing in front of the ground): one clip per outline,
 * nested, so overlapping outlines still each cut their own hole.
 */
export const Occlude: React.FC<{ holes: Pt[][]; W: number; H: number; children: React.ReactNode }> = ({ holes, W, H, children }) =>
  holes.reduce<React.ReactNode>((inner, h, i) => (
    <div key={i} style={{ position: "absolute", inset: 0, clipPath: `path(evenodd, "M-10,-10 H${W + 10} V${H + 10} H-10 Z M${h.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" L")} Z")` }}>{inner}</div>
  ), <>{children}</>) as React.ReactElement;

// ── highlighting a building ─────────────────────────────────────────────────
export type HighlightFx = "glow" | "neon" | "fill" | "scan" | "beacon";
export const HIGHLIGHTS: { id: HighlightFx; name: string }[] = [
  { id: "glow", name: "Viền sáng" }, { id: "neon", name: "Neon chạy quanh viền" }, { id: "fill", name: "Màu dâng lên" }, { id: "scan", name: "Vệt sáng quét" }, { id: "beacon", name: "Cột sáng trên nóc" },
];

/** the walls of a prism that face the camera (screen quads b0, b1, t1, t0 between heights z0 and z1) and its roof */
function faces(foot: Pt[], z0: number, z1: number, cam: Cam, toOut: (p: Pt) => Pt) {
  const n = foot.length, cxm = foot.reduce((s, p) => s + p[0], 0) / n, cym = foot.reduce((s, p) => s + p[1], 0) / n;
  const P = (x: number, y: number, z: number) => { const r = camProject(cam, x, y, z); return r.depth > 1 ? toOut(r.p) : null; };
  const walls: Pt[][] = [];
  foot.forEach((a, i) => {
    const c = foot[(i + 1) % n], mx = (a[0] + c[0]) / 2, my = (a[1] + c[1]) / 2;
    let nx = c[1] - a[1], ny = -(c[0] - a[0]);
    if (nx * (mx - cxm) + ny * (my - cym) < 0) { nx = -nx; ny = -ny; }
    if (nx * (cam.C[0] - mx) + ny * (cam.C[1] - my) <= 0) return;
    const q = [P(a[0], a[1], z0), P(c[0], c[1], z0), P(c[0], c[1], z1), P(a[0], a[1], z1)];
    if (q.every(Boolean)) walls.push(q as Pt[]);
  });
  const roof = foot.map(([x, y]) => P(x, y, z1));
  return { walls, roof: roof.every(Boolean) ? (roof as Pt[]) : null, centre: [cxm, cym] as Pt };
}

/** A building made to stand out: its outline glows, colour rises up it, a band of light sweeps up, or a beam of light
 *  stands on its roof; with its name over the roof if given. Used on real buildings of the clip (and new ones). */
export const Highlight: React.FC<{ id: string; foot: Pt[]; height: number; cam: Cam; toOut: (p: Pt) => Pt; t: number; at: number; fx: HighlightFx;
  color: string; label?: string; W: number; H: number }> = ({ id, foot, height: h, cam, toOut, t, at, fx, color, label, W, H }) => {
  const k = interpolate(t, [at, at + 1.2], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.out(Easing.cubic) });
  if (k <= 0 || foot.length < 3) return null;
  const full = faces(foot, 0, h, cam, toOut);
  const poly = (q: Pt[]) => q.map((p) => p.join(",")).join(" ");
  const breathe = 0.8 + 0.2 * Math.sin((t - at) * 2.4);
  // the edges of what is seen: uprights, top and bottom of the visible walls, the roof
  const edges: [Pt, Pt][] = [];
  for (const [b0, b1, t1, t0] of full.walls) edges.push([b0, b1], [b1, t1], [t0, b0], [t0, t1]);
  if (full.roof) full.roof.forEach((p, i) => edges.push([p, full.roof![(i + 1) % full.roof!.length]]));
  const fid = `hl-${id}`;
  const lines = (w: number, op: number, blur?: boolean) => edges.map(([a, b], i) => (
    <line key={i} x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} stroke={blur ? color : "#fff"} strokeWidth={w} opacity={op} strokeLinecap="round" filter={blur ? `url(#${fid})` : undefined} />
  ));
  let body: React.ReactNode = null;
  if (fx === "fill") {
    // colour fills the walls from the ground up, a bright line riding its top
    const lvl = faces(foot, 0, Math.max(0.5, h * k), cam, toOut);
    body = <>
      {lvl.walls.map((q, i) => <polygon key={i} points={poly(q)} fill={color} opacity={0.42} style={{ mixBlendMode: "screen" }} />)}
      {lvl.walls.map((q, i) => <line key={`l${i}`} x1={q[3][0]} y1={q[3][1]} x2={q[2][0]} y2={q[2][1]} stroke="#fff" strokeWidth={3} opacity={k < 1 ? 1 : 0.6} />)}
      {k >= 1 && full.roof ? <polygon points={poly(full.roof)} fill={color} opacity={0.4} style={{ mixBlendMode: "screen" }} /> : null}
      {lines(2, 0.5 * k)}
    </>;
  } else if (fx === "scan") {
    // a band of light climbing the walls again and again
    const u = ((t - at) * 0.45) % 1, band = faces(foot, Math.max(0, (u - 0.07) * h), Math.min(h, u * h), cam, toOut);
    body = <>
      {full.walls.map((q, i) => <polygon key={i} points={poly(q)} fill={color} opacity={0.12 * k} />)}
      {band.walls.map((q, i) => <polygon key={`b${i}`} points={poly(q)} fill={color} opacity={0.75 * k} filter={`url(#${fid})`} />)}
      {band.walls.map((q, i) => <polygon key={`c${i}`} points={poly(q)} fill="#fff" opacity={0.45 * k} />)}
      {lines(9, 0.6 * k, true)}{lines(1.6, 0.8 * k)}
    </>;
  } else if (fx === "beacon") {
    // a beam of light standing on the roof, and a ring going out from it
    const top = camProject(cam, full.centre[0], full.centre[1], h), sky = camProject(cam, full.centre[0], full.centre[1], h + h * 2.2 * k);
    const r = Math.sqrt(foot.reduce((s, p) => Math.max(s, (p[0] - full.centre[0]) ** 2 + (p[1] - full.centre[1]) ** 2), 0));
    const ringR = r * (0.6 + 1.6 * (((t - at) * 0.6) % 1)), ringOp = 1 - (((t - at) * 0.6) % 1);
    const ring = Array.from({ length: 32 }, (_, i) => { const a = (i / 32) * Math.PI * 2; const v = camProject(cam, full.centre[0] + Math.cos(a) * ringR, full.centre[1] + Math.sin(a) * ringR, h); return v.depth > 1 ? toOut(v.p) : null; });
    const a = top.depth > 1 ? toOut(top.p) : null, b = sky.depth > 1 ? toOut(sky.p) : null;
    const wpx = full.roof ? Math.max(8, (Math.max(...full.roof.map((p) => p[0])) - Math.min(...full.roof.map((p) => p[0]))) * 0.35) : 20;
    body = <>
      <defs><linearGradient id={`${fid}-beam`} x1={a?.[0] ?? 0} y1={a?.[1] ?? 0} x2={b?.[0] ?? 0} y2={b?.[1] ?? 0} gradientUnits="userSpaceOnUse">
        <stop offset="0" stopColor={color} stopOpacity={0.9} /><stop offset="1" stopColor={color} stopOpacity={0} /></linearGradient></defs>
      {a && b ? <polygon points={poly([[a[0] - wpx / 2, a[1]], [a[0] + wpx / 2, a[1]], [b[0] + wpx * 0.15, b[1]], [b[0] - wpx * 0.15, b[1]]])} fill={`url(#${fid}-beam)`} filter={`url(#${fid})`} /> : null}
      {a && b ? <line x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} stroke="#fff" strokeWidth={2} opacity={0.8} /> : null}
      {ring.every(Boolean) ? <polygon points={poly(ring as Pt[])} fill="none" stroke={color} strokeWidth={3} opacity={ringOp * k} /> : null}
      {lines(7, 0.55 * k * breathe, true)}{lines(1.5, 0.75 * k)}
    </>;
  } else if (fx === "neon") {
    // a neon tube on every edge, with pulses of light running along them
    const off = -((t - at) * 90) % 100;
    body = <>
      {lines(10, 0.55 * k * (0.85 + 0.15 * Math.sin(t * 23)), true)}
      {edges.map(([a, b], i) => <line key={`c${i}`} x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} stroke={color} strokeWidth={2.6} opacity={k} strokeLinecap="round" />)}
      {edges.map(([a, b], i) => <line key={`p${i}`} x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} stroke="#fff" strokeWidth={3} opacity={k} strokeLinecap="round"
        pathLength={100} strokeDasharray="14 36" strokeDashoffset={off + i * 17} filter={`url(#${fid})`} />)}
      {edges.map(([a, b], i) => <line key={`q${i}`} x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} stroke="#fff" strokeWidth={1.6} opacity={k} strokeLinecap="round"
        pathLength={100} strokeDasharray="8 42" strokeDashoffset={off + i * 17 - 3} />)}
    </>;
  } else {
    body = <>
      {full.walls.map((q, i) => <polygon key={i} points={poly(q)} fill={color} opacity={0.16 * k * breathe} style={{ mixBlendMode: "screen" }} />)}
      {lines(12, 0.75 * k * breathe, true)}{lines(2.2, 0.95 * k)}
    </>;
  }
  // the name over the roof
  const lt = camProject(cam, full.centre[0], full.centre[1], fx === "beacon" ? h * 1.25 : h);
  const lp = lt.depth > 1 ? toOut(lt.p) : null;
  return (
    <>
      <svg width={W} height={H} style={{ position: "absolute", inset: 0, overflow: "visible", pointerEvents: "none" }}>
        <defs><filter id={fid} x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation={6} /></filter></defs>
        {body}
      </svg>
      {label && lp ? <AreaTag text={label} x={Math.min(W - 200, Math.max(200, lp[0]))} y={Math.max(90, lp[1] - 24)} t={t} at={at + 0.6} /> : null}
    </>
  );
};

function hull(pts: Pt[]): Pt[] {
  const p = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cr = (o: Pt, a: Pt, b: Pt) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo: Pt[] = [], hi: Pt[] = [];
  for (const q of p) { while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
  for (const q of [...p].reverse()) { while (hi.length >= 2 && cr(hi[hi.length - 2], hi[hi.length - 1], q) <= 0) hi.pop(); hi.push(q); }
  return [...lo.slice(0, -1), ...hi.slice(0, -1)];
}
