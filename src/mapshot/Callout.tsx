/**
 * Callout: the red-and-gold "luxury" amenity badge (school, hospital, market, square, mall…) pinned to a ground
 * point. One template for every amenity; only the icon changes: a gold-ringed medallion with the icon, a red ribbon
 * with a gold rim carrying a title and a short line under it, a gold stem down to a pulsing dot on the spot.
 */
import React from "react";
import { Easing, interpolate } from "remotion";
import { FONT } from "../font";

type Pt = [number, number];
const DARK = "rgba(92,6,12,0.95)"; // details cut into an icon, the colour of the medallion behind it
const line = { fill: "none", stroke: "currentColor", strokeWidth: 2.1, strokeLinecap: "round", strokeLinejoin: "round" } as const;

/** 24 × 24 icons, drawn in the medallion's gold */
export const CALLOUT_ICONS = {
  pin: { name: "Vị trí", svg: <path d="M12 2a7 7 0 0 0-7 7c0 5.2 7 13 7 13s7-7.8 7-13a7 7 0 0 0-7-7zm0 9.6a2.6 2.6 0 1 1 0-5.2 2.6 2.6 0 0 1 0 5.2z" fillRule="evenodd" /> },
  school: { name: "Trường học", svg: <><path d="M12 3 1 8.6 12 14.2l9-4.6V16h2V8.6z" /><path d="M5 12.3V16c0 1.8 3.1 3.6 7 3.6s7-1.8 7-3.6v-3.7l-7 3.6z" /></> },
  hospital: { name: "Bệnh viện", svg: <path d="M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zm5 3.5v3.5H6.5v4H10v3.5h4V14h3.5v-4H14V6.5z" fillRule="evenodd" /> },
  market: { name: "Chợ, siêu thị", svg: <><path d="M1.5 3.5h3l2.4 10.3a1.6 1.6 0 0 0 1.6 1.2h8.4a1.6 1.6 0 0 0 1.5-1.1L21 7H5.6" {...line} /><circle cx="9.5" cy="19.6" r="1.9" /><circle cx="17" cy="19.6" r="1.9" /></> },
  mall: { name: "Trung tâm thương mại", svg: <><path d="M4.5 8h15l1 13.5h-17z" /><path d="M8.5 10.5V7a3.5 3.5 0 0 1 7 0v3.5" {...line} /></> },
  park: { name: "Công viên, quảng trường", svg: <path d="M12 2c-3 0-5.2 2.4-5.2 5.2-1.8.7-3 2.4-3 4.4 0 2.7 2.2 4.9 4.9 4.9H11V22h2v-5.5h2.3c2.7 0 4.9-2.2 4.9-4.9 0-2-1.2-3.7-3-4.4C17.2 4.4 15 2 12 2z" /> },
  beach: { name: "Biển", svg: <><path d="M10.8 21.5c.4-3.8.1-7.4-1.1-10.4" {...line} /><path d="M9.7 11.1C8 7.4 4.3 6.6 2 8c3-.1 5.3 1 7.7 3.1zm0 0c1-3.9 4.8-6 8.3-5.1-2.9.5-5.4 2.3-8.3 5.1zm0 0c-3-1.4-6.4-.6-8 1.9 2.5-1.2 5.2-1.6 8-1.9zm0 0c3 .1 5.8 1.7 6.8 4.2-2.2-1.6-4.4-2.7-6.8-4.2z" /><path d="M2 21c2-1.2 4-1.2 6 0s4 1.2 6 0 4-1.2 6 0" {...line} strokeWidth={1.8} /></> },
  building: { name: "Toà nhà", svg: <><path d="M4 21.5V5.5L12 2v19.5zM13.5 21.5V9l6.5 2v10.5z" /><path d="M6.5 7.5h3M6.5 11h3M6.5 14.5h3M15.8 13h2M15.8 16.5h2" stroke={DARK} strokeWidth={1.6} /></> },
  car: { name: "Giao thông", svg: <><path d="M5 10.5l1.6-4.3A2 2 0 0 1 8.5 5h7a2 2 0 0 1 1.9 1.2l1.6 4.3a2 2 0 0 1 2 2V17h-2v2.2h-3V17H8v2.2H5V17H3v-4.5a2 2 0 0 1 2-2zm2.3 0h9.4l-1.1-3.2H8.4z" fillRule="evenodd" /><circle cx="7" cy="13.8" r="1.3" fill={DARK} /><circle cx="17" cy="13.8" r="1.3" fill={DARK} /></> },
  home: { name: "Nhà ở", svg: <path d="M12 3 2 11.5h3V21h5.5v-6h3v6H19v-9.5h3z" /> },
  shield: { name: "An ninh", svg: <><path d="M12 2 4 5.2v6C4 16.1 7.4 20.3 12 22c4.6-1.7 8-5.9 8-10.8v-6z" /><path d="M8.3 12.2l2.6 2.6 4.9-5.4" stroke={DARK} strokeWidth={2.2} fill="none" strokeLinecap="round" strokeLinejoin="round" /></> },
  leaf: { name: "Không gian xanh", svg: <path d="M20.5 3.5C10.5 3.5 4 8.6 4 15c0 2 .6 3.6 1.4 5 1.1-4 4.1-7.9 9.1-10-4 3-6.4 6.5-7.4 10.5 1.2.4 2.3.5 3.5.5 6.6 0 9.9-8 9.9-17.5z" /> },
  star: { name: "Tiện ích", svg: <path d="M12 2.5l2.9 6.1 6.6.8-4.9 4.6 1.3 6.6L12 17.3l-5.9 3.3 1.3-6.6-4.9-4.6 6.6-.8z" /> },
} satisfies Record<string, { name: string; svg: React.ReactNode }>;
export type CalloutIcon = keyof typeof CALLOUT_ICONS;

const GOLD = "linear-gradient(135deg, #fff4c2 0%, #f3c64f 28%, #b8860b 55%, #ffe18a 78%, #8a5a00 100%)";
const RED = "linear-gradient(180deg, #d3202b 0%, #a10f19 48%, #6d050c 100%)";
const M = 104, STEM = 92, PH = 78; // medallion, stem, ribbon height (output pixels)

/** about how wide the badge is, to turn it round near the right edge */
export const calloutWidth = (title: string, sub?: string) => M / 2 + 92 + Math.max(title.length * 25, (sub?.length ?? 0) * 13.5);

export const Callout: React.FC<{ title: string; sub?: string; icon: CalloutIcon; p: Pt; t: number; at: number; flip?: boolean }> = ({ title, sub, icon, p, t, at, flip }) => {
  const ease = (a: number, b: number, e = Easing.out(Easing.cubic)) => interpolate(t, [at + a, at + b], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: e });
  const stem = ease(0, 0.4), medal = ease(0.25, 0.75, Easing.out(Easing.back(1.8))), ribbon = ease(0.55, 1.05), text = ease(0.85, 1.25);
  if (stem <= 0) return null;
  const ring = ((t - at) % 1.8) / 1.8;
  // a light sweep over the ribbon once it is out, then every 4 s
  const sw = t - at - 1.1, sweep = sw < 0 ? -1 : (sw % 4) / 0.9;
  const cy = -STEM - M / 2;
  return (
    <div style={{ position: "absolute", left: p[0], top: p[1], width: 0, height: 0, filter: "drop-shadow(0 8px 14px rgba(0,0,0,0.45))" }}>
      <div style={{ position: "absolute", left: -7, top: -7, width: 14, height: 14, borderRadius: "50%", background: GOLD, boxShadow: "0 0 14px 5px rgba(255,200,80,0.8)" }} />
      <div style={{ position: "absolute", left: -7 - 22 * ring, top: -7 - 9 * ring, width: 14 + 44 * ring, height: 14 + 18 * ring, borderRadius: "50%",
        border: "2px solid rgba(255,214,110,0.95)", opacity: 1 - ring }} />
      <div style={{ position: "absolute", left: -1.5, top: -STEM * stem, width: 3, height: STEM * stem, background: "linear-gradient(0deg, rgba(255,220,120,0.3), #ffe08a)",
        boxShadow: "0 0 8px rgba(255,200,90,0.9)" }} />
      {/* ribbon: gold rim, red body, title and the line under it */}
      <div style={{ position: "absolute", top: cy - PH / 2, ...(flip ? { right: M / 2 - 16 } : { left: M / 2 - 16 }), height: PH,
        clipPath: flip ? `inset(0 0 0 ${(1 - ribbon) * 100}%)` : `inset(0 ${(1 - ribbon) * 100}% 0 0)`,
        padding: 3, background: GOLD, borderRadius: flip ? `${PH / 2}px 0 0 ${PH / 2}px` : `0 ${PH / 2}px ${PH / 2}px 0`, boxShadow: "0 0 22px rgba(255,190,70,0.55)" }}>
        <div style={{ position: "relative", height: "100%", overflow: "hidden", background: RED, borderRadius: flip ? `${PH / 2 - 3}px 0 0 ${PH / 2 - 3}px` : `0 ${PH / 2 - 3}px ${PH / 2 - 3}px 0`,
          display: "flex", flexDirection: "column", justifyContent: "center", whiteSpace: "nowrap",
          padding: flip ? `0 ${16 + M / 2}px 0 34px` : `0 34px 0 ${16 + M / 2}px`, textAlign: flip ? "right" : "left", opacity: 0.35 + 0.65 * text }}>
          <div style={{ fontFamily: FONT, fontWeight: 900, fontSize: 32, letterSpacing: 1, lineHeight: 1.05, textTransform: "uppercase",
            background: "linear-gradient(180deg, #fffbe6 0%, #ffe39a 55%, #f0b93c 100%)", WebkitBackgroundClip: "text", backgroundClip: "text", color: "transparent",
            filter: "drop-shadow(0 2px 2px rgba(60,0,4,0.6))" }}>{title}</div>
          {sub ? <div style={{ fontFamily: FONT, fontWeight: 600, fontSize: 19, letterSpacing: 1.6, marginTop: 5, textTransform: "uppercase", color: "#f7dca0" }}>{sub}</div> : null}
          {sweep >= 0 && sweep <= 1 ? (
            <div style={{ position: "absolute", top: -20, bottom: -20, width: 70, left: `${-20 + sweep * 130}%`, transform: "skewX(-22deg)",
              background: "linear-gradient(90deg, rgba(255,255,255,0), rgba(255,240,200,0.45), rgba(255,255,255,0))" }} />
          ) : null}
        </div>
      </div>
      {/* medallion: gold ring, dark red disc, the icon */}
      <div style={{ position: "absolute", left: -M / 2, top: cy - M / 2, width: M, height: M, borderRadius: "50%", padding: 6, background: GOLD,
        transform: `scale(${medal})`, boxShadow: "0 0 26px rgba(255,190,70,0.7)" }}>
        <div style={{ width: "100%", height: "100%", borderRadius: "50%", border: "2px solid rgba(255,225,140,0.7)",
          background: "radial-gradient(circle at 35% 30%, #d8222d 0%, #9c0d17 45%, #5c0309 100%)", display: "flex", alignItems: "center", justifyContent: "center" }}>
          <svg viewBox="0 0 24 24" width={M * 0.5} height={M * 0.5} fill="#f5c84f" color="#f5c84f" style={{ filter: "drop-shadow(0 1px 1px rgba(60,0,4,0.7))" }}>
            {CALLOUT_ICONS[icon].svg}
          </svg>
        </div>
      </div>
    </div>
  );
};
