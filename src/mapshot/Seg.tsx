/**
 * A building followed through the clip by SAM 2 (scripts/segment.py): its exact outline on every frame, read from a
 * JSON file next to the clip. It is highlighted on that outline (no box: the real shape, whatever the drone does), the
 * rest of the picture can be dimmed, and the outline hides the ground layers behind the building.
 */
import React, { useEffect, useState } from "react";
import { Easing, continueRender, delayRender, interpolate, staticFile } from "remotion";
import { AreaTag } from "../tracked/TrackedShot";
import type { HighlightFx } from "./Building";

type Pt = [number, number];
export type SegData = { w: number; h: number; n: number; frames: { polys: Pt[][]; top: Pt | null; area: number }[]; iou: number[]; weak: number[] };

const cache = new Map<string, SegData>();
/** the outlines of these files (loaded once; the render waits for them) */
export function useSegs(srcs: string[], wait = true): Record<string, SegData | undefined> {
  const key = srcs.join("|");
  const [, bump] = useState(0);
  useEffect(() => {
    const missing = srcs.filter((s) => !cache.has(s));
    if (!missing.length) return;
    // inside a composition the render waits for them; the editor around the player does not hold anything up
    const h = wait ? delayRender(`outlines ${missing.join(", ")}`) : null;
    Promise.all(missing.map((s) => fetch(s.startsWith("http") ? s : staticFile(s)).then((r) => r.json()).then((j: SegData) => cache.set(s, j))))
      .catch(() => undefined)
      .finally(() => { bump((v) => v + 1); if (h !== null) continueRender(h); });
  }, [key]);
  return Object.fromEntries(srcs.map((s) => [s, cache.get(s)]));
}

/** the outline of frame f (frames of the cut), in output pixels */
export const segPolys = (d: SegData | undefined, f: number, toOut: (p: Pt) => Pt): Pt[][] => {
  const fr = d?.frames[Math.min(d.n - 1, Math.max(0, f))];
  return fr ? fr.polys.map((poly) => poly.map(([x, y]) => toOut([x * d!.w, y * d!.h]))) : [];
};

export const SegHighlight: React.FC<{ id: string; d: SegData; f: number; toOut: (p: Pt) => Pt; t: number; at: number; fx: HighlightFx; color: string;
  label?: string; dim?: boolean; W: number; H: number }> = ({ id, d, f, toOut, t, at, fx, color, label, dim, W, H }) => {
  const k = interpolate(t, [at, at + 1.0], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.out(Easing.cubic) });
  const polys = segPolys(d, f, toOut);
  if (k <= 0 || !polys.length) return null;
  const path = polys.map((q) => `M${q.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" L")} Z`).join(" ");
  const ys = polys.flat().map((p) => p[1]), xs = polys.flat().map((p) => p[0]);
  const y0 = Math.min(...ys), y1 = Math.max(...ys), x0 = Math.min(...xs), x1 = Math.max(...xs);
  const fr = d.frames[Math.min(d.n - 1, Math.max(0, f))];
  const top = fr.top ? toOut([fr.top[0] * d.w, fr.top[1] * d.h]) : [(x0 + x1) / 2, y0] as Pt;
  const breathe = 0.8 + 0.2 * Math.sin((t - at) * 2.4);
  const g = `sg-${id}`, clip = `sc-${id}`;
  let body: React.ReactNode;
  if (fx === "fill") {
    const lvl = y1 - (y1 - y0) * k;   // colour rising from the foot to the roof
    body = <>
      <g clipPath={`url(#${clip})`}><rect x={x0 - 4} y={lvl} width={x1 - x0 + 8} height={y1 - lvl + 4} fill={color} opacity={0.45} style={{ mixBlendMode: "screen" }} />
        {k < 1 ? <rect x={x0 - 4} y={lvl - 2} width={x1 - x0 + 8} height={4} fill="#fff" /> : null}</g>
      <path d={path} fill="none" stroke="#fff" strokeWidth={2} opacity={0.6 * k} />
    </>;
  } else if (fx === "scan") {
    const u = ((t - at) * 0.45) % 1, by = y1 - (y1 - y0) * u, bh = (y1 - y0) * 0.08;
    body = <>
      <path d={path} fill={color} opacity={0.12 * k} />
      <g clipPath={`url(#${clip})`}><rect x={x0 - 4} y={by - bh} width={x1 - x0 + 8} height={bh} fill={color} opacity={0.8 * k} filter={`url(#${g})`} />
        <rect x={x0 - 4} y={by - bh * 0.6} width={x1 - x0 + 8} height={bh * 0.25} fill="#fff" opacity={0.7 * k} /></g>
      <path d={path} fill="none" stroke={color} strokeWidth={9} opacity={0.55 * k} filter={`url(#${g})`} />
      <path d={path} fill="none" stroke="#fff" strokeWidth={1.6} opacity={0.8 * k} />
    </>;
  } else if (fx === "beacon") {
    const bw = Math.max(16, (x1 - x0) * 0.3), sky = Math.max(0, top[1] - (y1 - y0) * 1.6 * k);
    const ring = ((t - at) * 0.6) % 1;
    body = <>
      <defs><linearGradient id={`${g}-b`} x1="0" y1={top[1]} x2="0" y2={sky} gradientUnits="userSpaceOnUse">
        <stop offset="0" stopColor={color} stopOpacity={0.9} /><stop offset="1" stopColor={color} stopOpacity={0} /></linearGradient></defs>
      <polygon points={`${top[0] - bw / 2},${top[1]} ${top[0] + bw / 2},${top[1]} ${top[0] + bw * 0.15},${sky} ${top[0] - bw * 0.15},${sky}`} fill={`url(#${g}-b)`} filter={`url(#${g})`} />
      <ellipse cx={top[0]} cy={top[1]} rx={(x1 - x0) * (0.3 + 0.8 * ring)} ry={(x1 - x0) * (0.08 + 0.2 * ring)} fill="none" stroke={color} strokeWidth={3} opacity={(1 - ring) * k} />
      <path d={path} fill="none" stroke={color} strokeWidth={8} opacity={0.5 * k * breathe} filter={`url(#${g})`} />
      <path d={path} fill="none" stroke="#fff" strokeWidth={1.5} opacity={0.75 * k} />
    </>;
  } else if (fx === "neon") {
    // a neon tube on the outline, with pulses of light chasing round it (spaced on the outline's length, any size)
    const off = -((t - at) * 70) % 1000, flick = 0.85 + 0.15 * Math.sin(t * 23) * Math.sin(t * 7);
    body = <>
      <path d={path} fill={color} opacity={0.08 * k} />
      <path d={path} fill="none" stroke={color} strokeWidth={14} opacity={0.55 * k * flick} filter={`url(#${g})`} strokeLinejoin="round" />
      <path d={path} fill="none" stroke={color} strokeWidth={3} opacity={k} strokeLinejoin="round" />
      <path d={path} fill="none" stroke="#fff" strokeWidth={7} opacity={k} strokeLinecap="round" pathLength={1000} strokeDasharray="50 150" strokeDashoffset={off} filter={`url(#${g})`} />
      <path d={path} fill="none" stroke="#fff" strokeWidth={3.2} opacity={k} strokeLinecap="round" pathLength={1000} strokeDasharray="30 170" strokeDashoffset={off - 8} />
    </>;
  } else {
    body = <>
      <path d={path} fill={color} opacity={0.18 * k * breathe} style={{ mixBlendMode: "screen" }} />
      <path d={path} fill="none" stroke={color} strokeWidth={12} opacity={0.75 * k * breathe} filter={`url(#${g})`} strokeLinejoin="round" />
      <path d={path} fill="none" stroke="#fff" strokeWidth={2.2} opacity={0.95 * k} strokeLinejoin="round" />
    </>;
  }
  return (
    <>
      <svg width={W} height={H} style={{ position: "absolute", inset: 0, overflow: "visible", pointerEvents: "none" }}>
        <defs>
          <filter id={g} x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation={6} /></filter>
          <clipPath id={clip}><path d={path} /></clipPath>
        </defs>
        {/* the rest of the picture a little darker, so the building stands out */}
        {dim ? <path d={`M-10,-10 H${W + 10} V${H + 10} H-10 Z ${path}`} fillRule="evenodd" fill="#000" opacity={0.38 * k} /> : null}
        {body}
      </svg>
      {label ? <AreaTag text={label} x={Math.min(W - 200, Math.max(200, top[0]))} y={Math.max(90, top[1] - 24 - (fx === "beacon" ? (y1 - y0) * 0.35 : 0))} t={t} at={at + 0.5} /> : null}
    </>
  );
};
