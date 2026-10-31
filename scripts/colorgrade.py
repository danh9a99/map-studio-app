"""Colour for footage edits: match the clips to each other, then a look, as one 3D LUT per clip.

    python3 scripts/colorgrade.py output/<slug> [--look warm|natural|cinematic|none|<file.cube>] [--ref <clip name>]
                                         [--strength 0.7] [--preview]

Reads output/<slug>/source.mp4 + clips.json (+ shots.json when present, to measure only clean presenter / b-roll
frames). For every clip it measures the picture in CIE Lab (mean and spread of lightness and colour over ~12 frames)
and moves it toward the reference clip (the one with the most usable picture, or --ref) — exposure, white balance
and contrast differences between takes go away. Then the look, the same for every clip:
  warm       luxury real estate: warm highlights, a touch of teal in the shadows, soft S-curve, +5 % saturation
  natural    clean and true: neutral, a little contrast and clarity
  cinematic  teal & orange, deeper blacks, a little less saturation
  <file.cube> your own LUT
Skin tones are protected: inside the skin hue band the look is blended back toward the matched colour, so faces do
not turn orange or green. Writes grade/<clip>.cube, grade.json (what was measured, what was done) and
source-graded.mp4 (each clip through its LUT, joined in the same timeline). --preview: before / after stills per clip
in grade/preview-*.jpg instead of the full encode.
"""
import json
import os
import subprocess
import sys

import cv2
import numpy as np

N = 33  # LUT size


def frames(src, times):
    cap = cv2.VideoCapture(src)
    fps = cap.get(cv2.CAP_PROP_FPS) or 30
    out = []
    for t in times:
        cap.set(cv2.CAP_PROP_POS_FRAMES, int(round(t * fps)))
        ok, f = cap.read()
        if ok:
            out.append(cv2.resize(f, (f.shape[1] // 3, f.shape[0] // 3)))
    return out


def lab_stats(imgs):
    px = np.vstack([cv2.cvtColor(i.astype(np.float32) / 255, cv2.COLOR_BGR2LAB).reshape(-1, 3) for i in imgs])
    px = px[(px[:, 0] > 4) & (px[:, 0] < 97)]  # ignore clipped blacks / whites
    return px.mean(0), px.std(0)


def sample_times(clip, slots, k=12):
    """Clean frames of a clip: usable presenter or b-roll (shots.json), else spread over the clip."""
    if slots:
        good = [s["t"] + 0.25 for s in slots if clip["start"] <= s["t"] < clip["end"] and not s.get("junk")]
        if len(good) >= 4:
            idx = np.linspace(0, len(good) - 1, min(k, len(good))).round().astype(int)
            return [good[i] for i in idx], len(good) * 0.5
    a, b = clip["start"] + 0.3, clip["end"] - 0.3
    return list(np.linspace(a, b, k)), 0.0


def identity(n=N):
    g = np.linspace(0, 1, n, dtype=np.float32)
    b, gg, r = np.meshgrid(g, g, g, indexing="ij")  # .cube order: red fastest
    return np.stack([r, gg, b], -1).reshape(-1, 3)  # rows in .cube order, RGB 0..1


def to_lab(rgb):
    return cv2.cvtColor(rgb.reshape(-1, 1, 3).astype(np.float32), cv2.COLOR_RGB2LAB).reshape(-1, 3)


def to_rgb(lab):
    return np.clip(cv2.cvtColor(lab.reshape(-1, 1, 3).astype(np.float32), cv2.COLOR_LAB2RGB).reshape(-1, 3), 0, 1)


def match(rgb, src, ref, strength):
    """Reinhard transfer in Lab, softened: spread ratios kept within 0.8–1.25, applied at `strength`."""
    lab = to_lab(rgb)
    (ms, ss), (mr, sr) = src, ref
    ratio = np.clip(sr / np.maximum(ss, 1e-3), 0.8, 1.25)
    out = (lab - ms) * ratio + mr
    return to_rgb(lab + (out - lab) * strength)


def smooth(x):
    return x * x * (3 - 2 * x)


def look(rgb, name):
    if name in (None, "none"):
        return rgb
    r, g, b = rgb[:, 0], rgb[:, 1], rgb[:, 2]
    lum = 0.2126 * r + 0.7152 * g + 0.0722 * b
    if name == "warm":
        s = 0.9 * rgb + 0.1 * smooth(rgb)                       # soft S-curve
        hi = np.clip((lum - 0.45) / 0.55, 0, 1)[:, None]          # highlights warmer
        lo = np.clip((0.4 - lum) / 0.4, 0, 1)[:, None]            # shadows a touch teal
        s = s + hi * np.array([0.035, 0.012, -0.03]) + lo * np.array([-0.015, 0.006, 0.02])
        sat = 1.05
    elif name == "natural":
        s = 0.85 * rgb + 0.15 * smooth(rgb)
        sat = 1.02
    elif name == "cinematic":
        s = 0.8 * rgb + 0.2 * smooth(rgb)
        s = np.clip((s - 0.03) / 0.97, 0, 1)                      # deeper blacks
        hi = np.clip((lum - 0.5) / 0.5, 0, 1)[:, None]
        lo = np.clip((0.5 - lum) / 0.5, 0, 1)[:, None]
        s = s + hi * np.array([0.04, 0.015, -0.035]) + lo * np.array([-0.03, 0.01, 0.035])
        sat = 0.92
    else:
        raise SystemExit(f"look không có: {name}")
    l2 = (0.2126 * s[:, 0] + 0.7152 * s[:, 1] + 0.0722 * s[:, 2])[:, None]
    return np.clip(l2 + (s - l2) * sat, 0, 1)


def skin_mask(rgb):
    """1 inside the skin hue band (Lab hue ≈ 25–75°, moderate chroma, mid lightness), soft edges."""
    lab = to_lab(rgb)
    L, a, b = lab[:, 0], lab[:, 1], lab[:, 2]
    hue = np.degrees(np.arctan2(b, a)) % 360
    chroma = np.hypot(a, b)
    w = np.clip(1 - np.abs(hue - 50) / 30, 0, 1) * np.clip((chroma - 6) / 8, 0, 1) * np.clip((L - 20) / 15, 0, 1) * np.clip((92 - L) / 10, 0, 1)
    return w[:, None]


def read_cube(path):
    rows, size = [], None
    for ln in open(path):
        ln = ln.strip()
        if ln.startswith("LUT_3D_SIZE"):
            size = int(ln.split()[1])
        elif ln and (ln[0].isdigit() or ln[0] in "-.") and len(ln.split()) == 3:
            rows.append([float(v) for v in ln.split()])
    return size, np.array(rows, np.float32)


def apply_cube(rgb, cube):
    size, table = cube
    lut = table.reshape(size, size, size, 3)  # [b][g][r]
    idx = np.clip(rgb * (size - 1), 0, size - 1)
    i0 = np.floor(idx).astype(int); i1 = np.minimum(i0 + 1, size - 1); f = idx - i0
    out = np.zeros_like(rgb)
    for dr in (0, 1):
        for dg in (0, 1):
            for db in (0, 1):
                ir = np.where(dr, i1[:, 0], i0[:, 0]); ig = np.where(dg, i1[:, 1], i0[:, 1]); ib = np.where(db, i1[:, 2], i0[:, 2])
                w = (f[:, 0] if dr else 1 - f[:, 0]) * (f[:, 1] if dg else 1 - f[:, 1]) * (f[:, 2] if db else 1 - f[:, 2])
                out += lut[ib, ig, ir] * w[:, None]
    return out


def write_cube(path, rgb, title):
    with open(path, "w") as f:
        f.write(f'TITLE "{title}"\nLUT_3D_SIZE {N}\n')
        for r, g, b in rgb:
            f.write(f"{r:.6f} {g:.6f} {b:.6f}\n")


def main(d, look_name="warm", ref_name=None, strength=0.7, preview=False):
    src = os.path.join(d, "source.mp4")
    clips = json.load(open(os.path.join(d, "clips.json")))
    shots_f = os.path.join(d, "shots.json")
    slots = json.load(open(shots_f))["slots"] if os.path.exists(shots_f) else None
    stats, usable = [], []
    for c in clips:
        times, good = sample_times(c, slots)
        imgs = frames(src, times)
        stats.append(lab_stats(imgs) if imgs else None)
        usable.append(good if slots else c["end"] - c["start"])
    # the reference: most usable picture (a voice-over clip of empty chairs is never the reference)
    ok = [i for i, s in enumerate(stats) if s is not None and usable[i] > 0]
    ref_i = next((i for i, c in enumerate(clips) if c["name"] == ref_name), None) if ref_name else None
    if ref_i is None:
        ref_i = max(ok, key=lambda i: usable[i]) if ok else 0
    ref = stats[ref_i]
    cube = read_cube(look_name) if look_name and look_name.endswith(".cube") else None
    gdir = os.path.join(d, "grade")
    os.makedirs(gdir, exist_ok=True)
    base = identity()
    report = {"look": look_name, "reference": clips[ref_i]["name"], "strength": strength, "clips": []}
    for i, c in enumerate(clips):
        m = match(base, stats[i], ref, strength) if stats[i] is not None and i != ref_i and usable[i] > 0 else base
        lk = apply_cube(m, cube) if cube else look(m, look_name)
        skin = skin_mask(m)
        out = lk * (1 - 0.6 * skin) + (0.6 * skin) * (m * 0.5 + lk * 0.5)  # faces: half the look
        f = os.path.join(gdir, f"{i:02d}.cube")
        write_cube(f, out, f"{c['name']} · {look_name}")
        s = stats[i]
        report["clips"].append({"name": c["name"], "lut": os.path.relpath(f, d), "matched": i != ref_i and usable[i] > 0,
                                "L": round(float(s[0][0]), 1) if s else None, "a": round(float(s[0][1]), 1) if s else None,
                                "b": round(float(s[0][2]), 1) if s else None})
    json.dump(report, open(os.path.join(d, "grade.json"), "w"), ensure_ascii=False, indent=1)
    for r in report["clips"]:
        print(f"grade: {r['name']} · L {r['L']} a {r['a']} b {r['b']}{' · khớp theo ' + report['reference'] if r['matched'] else (' · mẫu' if r['name'] == report['reference'] else '')}")
    if preview:
        for i, c in enumerate(clips):
            t, _ = sample_times(c, slots, 3)
            img = frames(src, [t[len(t) // 2]])
            if not img:
                continue
            p = os.path.join(gdir, f"preview-{i:02d}.jpg")
            subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-ss", f"{t[len(t) // 2]:.2f}", "-i", src, "-frames:v", "1", "-filter_complex",
                            f"[0:v]scale=360:-2,split[a][b];[b]lut3d={os.path.join(gdir, f'{i:02d}.cube')}[g];[a][g]hstack", p], check=True)
            print("preview:", p)
        return
    # graded source: every clip through its LUT, same timeline
    parts = []
    for i, c in enumerate(clips):
        p = os.path.join(gdir, f"part-{i:02d}.mp4")
        subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-ss", f"{c['start']:.3f}", "-to", f"{c['end']:.3f}", "-i", src,
                        "-vf", f"lut3d={os.path.join(gdir, f'{i:02d}.cube')}:interp=tetrahedral", "-c:v", "h264_videotoolbox", "-b:v", "14M",
                        "-c:a", "copy", p], check=True)
        parts.append(p)
        print(f"GRADE {i + 1}/{len(clips)} {c['name']}", flush=True)
    lst = os.path.join(gdir, "list.txt")
    open(lst, "w").write("".join(f"file '{os.path.abspath(p)}'\n" for p in parts))
    out = os.path.join(d, "source-graded.mp4")
    subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-f", "concat", "-safe", "0", "-i", lst, "-c", "copy", "-movflags", "+faststart", out], check=True)
    for p in parts:
        os.remove(p)
    print(f"grade: {len(clips)} clip → {out}")


if __name__ == "__main__":
    a = sys.argv[1:]
    opt = lambda k, dflt=None: a[a.index(k) + 1] if k in a else dflt  # noqa: E731
    main(a[0], opt("--look", "warm"), opt("--ref"), float(opt("--strength", 0.7)), "--preview" in a)
