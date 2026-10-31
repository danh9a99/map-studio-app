#!/usr/bin/env python3
"""
Colour for a map clip: delog (D-Log M, D-Log, HLG or found automatically), then the user's own .cube LUT at a chosen
strength, then an optional look; all folded into one 33³ LUT and applied with ffmpeg.

  mapcolor.py <dir> [--delog auto|none|dlogm|dlog|hlg] [--lut file.cube] [--strength 0..1] [--look none|warm|natural|cinematic]
                    [--height 1080] [--still]

<dir> is a map work folder (meta.json: clip, start, dur). Writes color.cube, color.json and, with --still, before.jpg /
after.jpg (one frame, for the split preview); without --still, graded.mp4.

The log curves are the published DJI / ARIB formulas, but the gamut step is only a saturation boost, so the result is
close, not exact. For an exact delog, give DJI's official LUT as the user LUT at 100% with --delog none.
"""
import argparse
import json
import os
import subprocess
import sys

import cv2
import numpy as np

sys.path.insert(0, os.path.dirname(__file__))
from colorgrade import apply_cube, identity, look, read_cube, write_cube  # noqa: E402


def dlog_inv(y):  # DJI D-Log white paper
    return np.where(y > 0.14, (10 ** ((y - 0.584555) / 0.256663) - 0.0108) / 0.9892, (y - 0.0929) / 6.025)


def dlogm_inv(y):  # D-Log M: flatter toe, mid grey near 0.40 (approximation)
    return np.where(y > 0.14, (10 ** ((y - 0.579) / 0.2472) - 0.0108) / 0.9892, (y - 0.0929) / 6.025)


def hlg_inv(y):  # ARIB STD-B67, scaled so HLG mid grey lands on 0.18
    a, b, c = 0.17883277, 0.28466892, 0.55991073
    e = np.where(y <= 0.5, y * y / 3, (np.exp((y - c) / a) + b) / 12)
    return e * 3.75


CURVES = {"dlog": (dlog_inv, 1.35), "dlogm": (dlogm_inv, 1.25), "hlg": (hlg_inv, 1.2)}
# DJI publishes no D-Log M formula, only conversion LUTs: with DJI's own file here, D-Log M uses it exactly
DJI_DLOGM = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "assets", "luts", "dji",
                         "mavic-4-pro-dlog-m-to-rec709.cube")


def to_display(x):
    """scene linear → Rec.709-ish display: soft highlight roll-off (white at 4× mid grey), then gamma."""
    x = np.maximum(x, 0)
    d = x * (1 + x / 16) / (1 + x)
    return np.clip(d, 0, 1) ** (1 / 2.2)


def delog(rgb, kind):
    if kind in (None, "none"):
        return rgb
    if kind == "dlogm" and os.path.exists(DJI_DLOGM):
        return np.clip(apply_cube(rgb, read_cube(DJI_DLOGM)), 0, 1)
    inv, sat = CURVES[kind]
    out = to_display(inv(rgb))
    lum = (0.2126 * out[:, 0] + 0.7152 * out[:, 1] + 0.0722 * out[:, 2])[:, None]
    return np.clip(lum + (out - lum) * sat, 0, 1)


def grab(meta, t=None, w=960):
    cap = cv2.VideoCapture(meta["clip"])
    cap.set(cv2.CAP_PROP_POS_MSEC, (meta["start"] + (t if t is not None else meta["dur"] / 2)) * 1000)
    ok, f = cap.read()
    if not ok:
        raise SystemExit("không đọc được khung hình")
    return cv2.resize(f, (w, int(f.shape[0] * w / f.shape[1])))


def detect(meta):
    """HLG from the file's transfer tag; otherwise flat and pale over a few frames → D-Log M."""
    tag = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=color_transfer", "-of", "csv=p=0", meta["clip"]],
                         capture_output=True, text=True).stdout.strip()
    if tag == "arib-std-b67":
        return "hlg", {"transfer": tag}
    lo, hi, sat = [], [], []
    for t in np.linspace(0.3, max(0.4, meta["dur"] - 0.3), 4):
        f = grab(meta, float(t), 480)
        g = cv2.cvtColor(f, cv2.COLOR_BGR2GRAY) / 255
        lo.append(np.percentile(g, 1)); hi.append(np.percentile(g, 99))
        sat.append(cv2.cvtColor(f, cv2.COLOR_BGR2HSV)[:, :, 1].mean() / 255)
    lo, hi, sat = np.median(lo), np.median(hi), np.median(sat)
    # lifted blacks and pale colour; log highlights can still reach 0.9+ on a sunny scene, so the top end is not a test
    is_log = lo > 0.12 and sat < 0.22
    return ("dlogm" if is_log else "none"), {"black": round(float(lo), 3), "white": round(float(hi), 3), "sat": round(float(sat), 3)}


def build(delog_kind, lut_path, strength, look_name):
    rgb = identity()
    rgb = delog(rgb, delog_kind)
    if lut_path:
        cube = read_cube(lut_path)
        rgb = rgb + (np.clip(apply_cube(rgb, cube), 0, 1) - rgb) * strength
    return np.clip(look(rgb, look_name), 0, 1)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("dir")
    ap.add_argument("--delog", default="auto", choices=["auto", "none", "dlogm", "dlog", "hlg"])
    ap.add_argument("--lut")
    ap.add_argument("--strength", type=float, default=1.0)
    ap.add_argument("--look", default="none")
    ap.add_argument("--height", type=int, default=1080)
    ap.add_argument("--still", action="store_true")
    ap.add_argument("--detect", action="store_true", help="only find out whether the clip is log; print it")
    ap.add_argument("--fast", action="store_true", help="bake from the 1080p working copy (track.mp4): seconds, for the editor")
    a = ap.parse_args()
    meta = json.load(open(os.path.join(a.dir, "meta.json")))
    kind, stats = (detect(meta) if a.delog == "auto" else (a.delog, None))
    if a.detect:
        info = {"delog": kind, "asked": a.delog, "stats": stats}
        json.dump(info, open(os.path.join(a.dir, "color.json"), "w"), ensure_ascii=False)
        print(json.dumps(info, ensure_ascii=False))
        return
    rows = build(kind, a.lut, max(0.0, min(1.0, a.strength)), a.look)
    cube_f = os.path.join(a.dir, "color.cube")
    write_cube(cube_f, rows, "map colour")
    info = {"delog": kind, "asked": a.delog, "lut": os.path.basename(a.lut) if a.lut else None, "strength": a.strength, "look": a.look, "stats": stats}
    json.dump(info, open(os.path.join(a.dir, "color.json"), "w"), ensure_ascii=False)
    if a.still:
        f = grab(meta)
        cv2.imwrite(os.path.join(a.dir, "before.jpg"), f, [cv2.IMWRITE_JPEG_QUALITY, 88])
        px = cv2.cvtColor(f, cv2.COLOR_BGR2RGB).reshape(-1, 3).astype(np.float32) / 255
        out = apply_cube(px, (33, rows.astype(np.float32))).reshape(f.shape)
        cv2.imwrite(os.path.join(a.dir, "after.jpg"), cv2.cvtColor((np.clip(out, 0, 1) * 255).astype(np.uint8), cv2.COLOR_RGB2BGR), [cv2.IMWRITE_JPEG_QUALITY, 88])
    else:
        h = a.height
        src = ["-i", os.path.join(a.dir, "track.mp4")] if a.fast else ["-ss", str(meta["start"]), "-t", str(meta["dur"]), "-i", meta["clip"]]
        p = subprocess.Popen(["ffmpeg", "-y", "-v", "error", "-nostats", "-progress", "pipe:1", *src,
                              "-vf", f"lut3d=file={cube_f}:interp=tetrahedral,scale=-2:{h},fps=30", "-an", "-c:v", "libx264", "-crf", "17",
                              "-preset", "veryfast" if a.fast else "fast", "-pix_fmt", "yuv420p", os.path.join(a.dir, "graded.mp4")],
                             stdout=subprocess.PIPE, text=True)
        for line in p.stdout:   # "P fraction" lines for whoever runs us
            if line.startswith("out_time_us=") and line[12:].strip().isdigit():
                print(f"P {min(1.0, int(line[12:]) / 1e6 / max(0.1, meta['dur'])):.3f}", flush=True)
        if p.wait():
            raise SystemExit("ffmpeg không nướng được màu")
    print(json.dumps(info, ensure_ascii=False))


if __name__ == "__main__":
    main()
