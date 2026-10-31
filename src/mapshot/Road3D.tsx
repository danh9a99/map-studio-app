/**
 * Road styles drawn in the ground's own perspective (with the 3D camera of the frame): sizes are in metres, so a road
 * is wide where it is near and thin where it is far, and what stands on it (a wall of light, car light trails) leans
 * with the view. Used instead of the flat line styles when the clip has a fitted ground.
 */
import React from "react";
import { Easing, interpolate } from "remotion";
import { camProject, type Cam } from "./Building";

type Pt = [number, number];
export type Road3DStyle = "surface" | "wall" | "trails" | "route" | "particles" | "gradient" | "markings" | "wave" | "grid";
export const ROAD3D: { id: Road3DStyle; name: string }[] = [
  { id: "surface", name: "Phủ mặt đường" }, { id: "wall", name: "Tường ánh sáng" }, { id: "trails", name: "Vệt đèn xe" }, { id: "route", name: "Lộ trình 3D" },
  { id: "particles", name: "Hạt sáng theo làn" }, { id: "gradient", name: "Dải chuyển màu" }, { id: "markings", name: "Vạch kẻ phát sáng" },
  { id: "wave", name: "Sóng sáng lan" }, { id: "grid", name: "Lưới hologram" },
];

/** a colour turned round the colour wheel by `deg` (the second colour of a gradient) */
function hueShift(hex: string, deg: number) {
  const n = parseInt(hex.slice(1), 16), r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, d = mx - mn;
  let h = 0;
  if (d) h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  const sat = d ? d / (1 - Math.abs(2 * l - 1)) : 0;
  h = (((h * 60 + deg) % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * sat, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = l - c / 2;
  const [a, bb, cc] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return `rgb(${Math.round((a + m) * 255)},${Math.round((bb + m) * 255)},${Math.round((cc + m) * 255)})`;
}
/** the same small noise for the same inputs (a render of a frame must always come out the same) */
const noise = (i: number, k: number) => { const v = Math.sin(i * 127.1 + k * 311.7) * 43758.5453; return v - Math.floor(v); };
export const isRoad3D = (s: string): s is Road3DStyle => ROAD3D.some((r) => r.id === s);

/** a polyline in metres, resampled every `step` metres, with its running length */
function dense(p: Pt[], step = 3): { pts: Pt[]; s: number[] } {
  const pts: Pt[] = [p[0]], s = [0];
  for (let i = 1; i < p.length; i++) {
    const [ax, ay] = p[i - 1], [bx, by] = p[i], L = Math.hypot(bx - ax, by - ay), n = Math.max(1, Math.ceil(L / step));
    for (let k = 1; k <= n; k++) { pts.push([ax + ((bx - ax) * k) / n, ay + ((by - ay) * k) / n]); s.push(s[s.length - 1] + L / n); }
  }
  return { pts, s };
}
/** sideways (in metres) from a resampled line, left positive */
function side(pts: Pt[], o: number): Pt[] {
  return pts.map((q, i) => {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)], dx = b[0] - a[0], dy = b[1] - a[1], n = Math.hypot(dx, dy) || 1;
    return [q[0] - (dy / n) * o, q[1] + (dx / n) * o];
  });
}
/** the part of a line between lengths s0 and s1 (metres) */
function piece(pts: Pt[], s: number[], s0: number, s1: number): Pt[] {
  const out: Pt[] = [];
  const at = (v: number): Pt => {
    let i = 1; while (i < s.length - 1 && s[i] < v) i++;
    const u = (v - s[i - 1]) / Math.max(1e-6, s[i] - s[i - 1]);
    return [pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * u, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * u];
  };
  out.push(at(s0));
  for (let i = 0; i < s.length; i++) if (s[i] > s0 && s[i] < s1) out.push(pts[i]);
  out.push(at(s1));
  return out;
}

export const Road3D: React.FC<{ id: string; foot: Pt[]; cam: Cam; toOut: (p: Pt) => Pt; style: Road3DStyle; color: string; width: number;
  speed?: number; t: number; t0: number; W: number; H: number }> = ({ id, foot, cam, toOut, style, color, width, speed = 1, t, t0, W, H }) => {
  if (foot.length < 2) return null;
  const draw = interpolate(t, [t0, t0 + 1.6], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.inOut(Easing.cubic) });
  if (draw <= 0) return null;
  const { pts, s } = dense(foot);
  const L = s[s.length - 1], shown = L * draw;
  // a ground (or raised) point → screen, or null behind the camera
  const P = (q: Pt, z = 0): Pt | null => { const r = camProject(cam, q[0], q[1], z); return r.depth > 2 ? toOut(r.p) : null; };
  const depth = (q: Pt) => camProject(cam, q[0], q[1], 0).depth;
  const poly = (q: (Pt | null)[]) => (q.every(Boolean) ? (q as Pt[]).map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" ") : null);
  // a band on the ground from s0 to s1, `w` metres wide, `o` metres off the centre: one polygon per few metres
  const band = (s0: number, s1: number, w: number, o = 0, z0 = 0, z1 = 0) => {
    const c = piece(pts, s, s0, s1), l = side(c, o + w / 2), r = side(c, o - w / 2);
    return poly([...l.map((q) => P(q, z0)), ...r.reverse().map((q) => P(q, z1))]);
  };
  const lineOf = (c: Pt[], z = 0) => { const q = c.map((p) => P(p, z)); return q.every(Boolean) ? (q as Pt[]).map((p) => p.join(",")).join(" ") : null; };
  // the screen size of a metre at a point (for strokes that should shrink with distance)
  const px = (q: Pt) => (cam.f * toOut([1, 0])[0] - cam.f * toOut([0, 0])[0]) / Math.max(1, depth(q));
  const glow = `r3g-${id}`;
  const defs = <defs><filter id={glow} x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation={4} /></filter></defs>;
  // the visible stretch in chunks of ~6 m (each chunk is projected on its own, so bends and distance stay right)
  const chunks: [number, number][] = [];
  for (let a = 0; a < shown; a += 6) chunks.push([a, Math.min(shown, a + 6.4)]);

  if (style === "surface") {
    // the road itself painted: a translucent surface, bright kerbs, lane dashes running along it
    const dashes: [number, number][] = [];
    const run = (t * 14 * speed) % 12;
    for (let a = -12 + run; a < shown; a += 12) dashes.push([Math.max(0, a), Math.min(shown, a + 5)]);
    return <g>{defs}
      {chunks.map(([a, b], i) => { const q = band(a, b, width); return q ? <polygon key={i} points={q} fill={color} opacity={0.32} /> : null; })}
      {[1, -1].map((sg) => { const q = lineOf(side(piece(pts, s, 0, shown), (sg * width) / 2)); return q ? <polyline key={sg} points={q} fill="none" stroke={color} strokeWidth={3} filter={`url(#${glow})`} /> : null; })}
      {[1, -1].map((sg) => { const q = lineOf(side(piece(pts, s, 0, shown), (sg * width) / 2)); return q ? <polyline key={`c${sg}`} points={q} fill="none" stroke="#fff" strokeWidth={1.4} opacity={0.9} /> : null; })}
      {dashes.filter(([a, b]) => b > a).map(([a, b], i) => { const q = band(a, b, Math.max(0.5, width * 0.06)); return q ? <polygon key={`d${i}`} points={q} fill="#fff" opacity={0.85} /> : null; })}
    </g>;
  }
  if (style === "wall") {
    // a curtain of light standing on the road's centre line, brightest at the foot, fading upward, a shimmer running along
    const hgt = Math.max(4, width * 0.8), sweep = (t * 30 * speed) % Math.max(40, L);
    return <g>{defs}
      <defs><linearGradient id={`${glow}-v`} x1="0" y1="1" x2="0" y2="0"><stop offset="0" stopColor={color} stopOpacity={0.75} /><stop offset="1" stopColor={color} stopOpacity={0} /></linearGradient></defs>
      {chunks.map(([a, b], i) => {
        const c = piece(pts, s, a, b), q = poly([...c.map((p) => P(p, 0)), ...c.slice().reverse().map((p) => P(p, hgt))]);
        return q ? <polygon key={i} points={q} fill={`url(#${glow}-v)`} /> : null;
      })}
      {chunks.map(([a, b], i) => {
        const c = piece(pts, s, a, b), q = poly([...c.map((p) => P(p, 0)), ...c.slice().reverse().map((p) => P(p, hgt * 0.25))]);
        return q ? <polygon key={`b${i}`} points={q} fill={color} opacity={0.35} /> : null;
      })}
      {(() => { const q = lineOf(piece(pts, s, 0, shown)); return q ? <><polyline points={q} fill="none" stroke={color} strokeWidth={6} filter={`url(#${glow})`} /><polyline points={q} fill="none" stroke="#fff" strokeWidth={2} /></> : null; })()}
      {sweep < shown ? (() => {
        const c = piece(pts, s, Math.max(0, sweep - 6), Math.min(shown, sweep)), q = poly([...c.map((p) => P(p, 0)), ...c.slice().reverse().map((p) => P(p, hgt))]);
        return q ? <polygon points={q} fill="#fff" opacity={0.45} filter={`url(#${glow})`} /> : null;
      })() : null}
    </g>;
  }
  if (style === "trails") {
    // long-exposure car lights: white going one way on one side, red coming back on the other, each lane its own pace
    const lanes = [{ o: width * 0.3, c: "#fff6dc", dir: 1, v: 26 }, { o: width * 0.12, c: "#ffe7a6", dir: 1, v: 19 },
      { o: -width * 0.12, c: "#ff4b3a", dir: -1, v: 22 }, { o: -width * 0.3, c: "#ff7a4a", dir: -1, v: 16 }];
    return <g>{defs}
      {lanes.map((ln, k) => {
        const per = 34 + k * 7, len = 16 + k * 3, base = ((t * ln.v * speed * ln.dir) % per + per) % per;
        const segs: React.ReactNode[] = [];
        for (let a = base - per; a < shown; a += per) {
          const s0 = Math.max(0, a), s1 = Math.min(shown, a + len);
          if (s1 <= s0) continue;
          const c = side(piece(pts, s, s0, s1), ln.o), q = lineOf(c, 0.6);
          if (!q) continue;
          const wpx = Math.max(1.2, Math.min(9, px(c[Math.floor(c.length / 2)]) * 0.45));
          segs.push(<polyline key={`${k}-${a}`} points={q} fill="none" stroke={ln.c} strokeWidth={wpx * 2.4} opacity={0.5} filter={`url(#${glow})`} strokeLinecap="round" />,
            <polyline key={`${k}-${a}-c`} points={q} fill="none" stroke={ln.c} strokeWidth={wpx} strokeLinecap="round" />);
        }
        return <g key={k}>{segs}</g>;
      })}
    </g>;
  }
  if (style === "particles") {
    // glowing beads flowing along the lanes, each its own pace, smaller with distance
    const lanes = [-0.32, -0.11, 0.11, 0.32];
    const beads: React.ReactNode[] = [];
    lanes.forEach((o, k) => {
      const n = Math.max(6, Math.floor(shown / 9));
      for (let i = 0; i < n; i++) {
        const v = (9 + 9 * noise(i, k)) * speed * (k < 2 ? -1 : 1), s0 = (((noise(i, k + 7) * L + t * v) % L) + L) % L;
        if (s0 > shown) continue;
        const c = side(piece(pts, s, Math.max(0, s0 - 0.01), Math.min(L, s0 + 0.01)), o * width)[0], p = P(c, 0.4);
        if (!p) continue;
        const r = Math.max(1.2, Math.min(8, px(c) * 0.35)), tw = 0.6 + 0.4 * Math.sin(t * 5 + i);
        beads.push(<circle key={`${k}-${i}`} cx={p[0]} cy={p[1]} r={r * 2.6} fill={color} opacity={0.45 * tw} filter={`url(#${glow})`} />,
          <circle key={`${k}-${i}-c`} cx={p[0]} cy={p[1]} r={r} fill="#fff" opacity={0.95} />);
      }
    });
    return <g>{defs}
      {chunks.map(([a, b], i) => { const q = band(a, b, width); return q ? <polygon key={i} points={q} fill={color} opacity={0.12} /> : null; })}
      {beads}
    </g>;
  }
  if (style === "gradient") {
    // a band from one colour to the next along the road, soft at its edges, a bright swell rolling along it
    const c2 = hueShift(color, 55), roll = (t * 0.25 * speed) % 1;
    return <g>{defs}
      <defs><linearGradient id={`${glow}-g`}><stop offset="0" stopColor={color} /><stop offset="1" stopColor={c2} /></linearGradient></defs>
      {chunks.map(([a, b], i) => { const q = band(a, b, width * 1.35); return q ? <polygon key={`o${i}`} points={q} fill={a / L < 0.5 ? color : c2} opacity={0.18} filter={`url(#${glow})`} /> : null; })}
      {chunks.map(([a, b], i) => {
        const u = a / Math.max(1, L), q = band(a, b, width);
        const mixc = `color-mix(in srgb, ${color} ${Math.round((1 - u) * 100)}%, ${c2})`;
        const swell = Math.max(0, 1 - Math.abs(((u - roll + 1.5) % 1) - 0.5) * 8);
        return q ? <polygon key={i} points={q} fill={mixc} opacity={0.62 + 0.3 * swell} /> : null;
      })}
      {(() => { const q = lineOf(side(piece(pts, s, 0, shown), width / 2)); const r = lineOf(side(piece(pts, s, 0, shown), -width / 2));
        return <>{q ? <polyline points={q} fill="none" stroke="#fff" strokeWidth={1.2} opacity={0.7} /> : null}{r ? <polyline points={r} fill="none" stroke="#fff" strokeWidth={1.2} opacity={0.7} /> : null}</>; })()}
    </g>;
  }
  if (style === "markings") {
    // the road's own markings lit up: solid edge lines, a double centre line, lane dashes, drawn in as it appears
    const thin = Math.max(0.25, width * 0.025);
    const dashes = (o: number) => { const out: React.ReactNode[] = []; for (let a = 0; a < shown; a += 9) { const q = band(a, Math.min(shown, a + 4.5), thin, o); if (q) out.push(<polygon key={`${o}-${a}`} points={q} fill="#fff" />); } return out; };
    const solid = (o: number, c: string) => chunks.map(([a, b], i) => { const q = band(a, b, thin * 1.4, o); return q ? <polygon key={`${o}-${i}`} points={q} fill={c} /> : null; });
    return <g>{defs}
      <g filter={`url(#${glow})`} opacity={0.9}>{solid(width / 2, color)}{solid(-width / 2, color)}{solid(thin * 1.6, "#ffd34d")}{solid(-thin * 1.6, "#ffd34d")}</g>
      {solid(width / 2, color)}{solid(-width / 2, color)}{solid(thin * 1.6, "#ffe48a")}{solid(-thin * 1.6, "#ffe48a")}
      {dashes(width / 4)}{dashes(-width / 4)}
    </g>;
  }
  if (style === "wave") {
    // bands of light rolling down the road, one after another, across its full width
    const gapm = 40, run = (t * 22 * speed) % gapm;
    const waves: React.ReactNode[] = [];
    for (let a = run - gapm; a < shown; a += gapm) {
      for (let k = 0; k < 6; k++) {   // a soft-edged band: thin slices, brightest in the middle
        const s0 = Math.max(0, a + k * 1.4), s1 = Math.min(shown, s0 + 1.5);
        if (s1 <= s0) continue;
        const q = band(s0, s1, width);
        if (q) waves.push(<polygon key={`${a}-${k}`} points={q} fill={k === 3 ? "#fff" : color} opacity={[0.2, 0.4, 0.7, 0.95, 0.7, 0.35][k]} />);
      }
    }
    return <g>{defs}
      {chunks.map(([a, b], i) => { const q = band(a, b, width); return q ? <polygon key={i} points={q} fill={color} opacity={0.16} /> : null; })}
      <g filter={`url(#${glow})`}>{waves}</g>{waves}
    </g>;
  }
  if (style === "grid") {
    // a holographic grid laid on the road: lines across it every few metres scrolling along, two along it, glowing edges
    const step = Math.max(3, width * 0.35), run = (t * 8 * speed) % step;
    const across: React.ReactNode[] = [];
    for (let a = run; a < shown; a += step) {
      const q = band(a, Math.min(shown, a + 0.25), width);
      if (q) across.push(<polygon key={a} points={q} fill={color} opacity={0.85} />);
    }
    const along = [-0.5, -0.17, 0.17, 0.5].map((o) => lineOf(side(piece(pts, s, 0, shown), o * width)));
    return <g>{defs}
      {chunks.map(([a, b], i) => { const q = band(a, b, width); return q ? <polygon key={i} points={q} fill={color} opacity={0.1} /> : null; })}
      <g filter={`url(#${glow})`}>{across}{along.map((q, i) => (q ? <polyline key={i} points={q} fill="none" stroke={color} strokeWidth={i % 3 ? 1.2 : 3} /> : null))}</g>
      {across}{along.map((q, i) => (q ? <polyline key={`c${i}`} points={q} fill="none" stroke={i % 3 ? color : "#fff"} strokeWidth={i % 3 ? 1 : 1.6} opacity={0.9} /> : null))}
    </g>;
  }
  // route: a wide band in a colour gradient along the way, a soft shadow, a white spine and a glowing head; arrows ride it
  const hex = (h: string) => { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
  const [r0, g0, b0] = hex(color), mix = (u: number) => `rgb(${Math.round(r0 + (255 - r0) * 0.55 * u)},${Math.round(g0 + (255 - g0) * 0.55 * u)},${Math.round(b0 + (255 - b0) * 0.55 * u)})`;
  const head = pts[Math.min(pts.length - 1, s.findIndex((v) => v >= shown) < 0 ? pts.length - 1 : s.findIndex((v) => v >= shown))];
  const hp = P(head);
  const arrows: React.ReactNode[] = [];
  const gap = 28, run = (t * 16 * speed) % gap;
  for (let a = run; a < shown - 6; a += gap) {
    const c = piece(pts, s, a, a + 5), mid = c[Math.floor(c.length / 2)], end = c[c.length - 1], st = c[0];
    const dx = end[0] - st[0], dy = end[1] - st[1], n = Math.hypot(dx, dy) || 1, nx = -dy / n, ny = dx / n, hw = width * 0.32;
    const q = poly([P([st[0] + nx * hw, st[1] + ny * hw]), P(end), P([st[0] - nx * hw, st[1] - ny * hw]), P(mid)]);
    if (q) arrows.push(<polygon key={a} points={q} fill="#fff" opacity={0.9} />);
  }
  return <g>{defs}
    {chunks.map(([a, b], i) => { const q = band(a, b, width * 1.15); return q ? <polygon key={`s${i}`} points={q} fill="#000" opacity={0.28} filter={`url(#${glow})`} transform="translate(0 6)" /> : null; })}
    {chunks.map(([a, b], i) => { const q = band(a, b, width); return q ? <polygon key={i} points={q} fill={mix(a / Math.max(1, L))} opacity={0.88} /> : null; })}
    {(() => { const q = lineOf(piece(pts, s, 0, shown)); return q ? <polyline points={q} fill="none" stroke="#fff" strokeWidth={2} opacity={0.75} /> : null; })()}
    {arrows}
    {draw < 1 && hp ? <><circle cx={hp[0]} cy={hp[1]} r={Math.max(8, px(head) * width * 0.6)} fill={color} opacity={0.6} filter={`url(#${glow})`} /><circle cx={hp[0]} cy={hp[1]} r={Math.max(3, px(head) * width * 0.22)} fill="#fff" /></> : null}
  </g>;
};
