#!/usr/bin/env python3
"""
Follow buildings through a map clip with SAM 2: clicks on one frame, their outlines on every frame.

    .venv-ml/bin/python scripts/segment.py <work dir> --id <name> --frame F --points '[[x, y, 1], ...]'
        [--out <dir>] [--model small|tiny] [--progress]

<work dir> is a drone-map work folder (track.mp4, the 30 fps working copy the layers are tracked on). Points are
[x, y, label, object]: fractions of the frame; label 1 = on the building, 0 = not it; object numbers the buildings
(all followed in one pass). Frames are cut once to <work dir>/frames/ (kept for
the next run). SAM 2 holds a whole clip in memory, so it runs in chunks of CHUNK frames, each chunk started from the
last mask of the one before, forward and backward from the clicked frame.

Writes <out>/seg-<id>-<object>.json for each building: per frame the outline (polygons, fractions), the top of the building (for a label) and
its area; the overlap (IoU) of each frame's mask with the one before and the frames where it drops (weak); and
<out>/seg-<id>-<object>-debug-{first,mid,last}.jpg to look at. Prints RESULT [{id, n, iouMin, weak}, ...].
"""
import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile

import cv2
import numpy as np

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MODELS = {"small": ("configs/sam2.1/sam2.1_hiera_s.yaml", "sam2.1_hiera_small.pt"), "tiny": ("configs/sam2.1/sam2.1_hiera_t.yaml", "sam2.1_hiera_tiny.pt")}
CHUNK = 90           # frames SAM 2 holds at once
WEAK_IOU = 0.82      # frame-to-frame overlap below this is reported


def frames_of(work):
    """The working copy as numbered JPEGs (SAM 2 reads a folder), cut once."""
    d = os.path.abspath(os.path.join(work, "frames"))
    n = int(subprocess.run(["ffprobe", "-v", "error", "-count_packets", "-select_streams", "v:0", "-show_entries", "stream=nb_read_packets",
                            "-of", "csv=p=0", os.path.join(work, "track.mp4")], capture_output=True, text=True).stdout.strip() or 0)
    src = os.path.join(work, "track.mp4")
    stamp = f"{os.path.getmtime(src):.0f}-{os.path.getsize(src)}"   # a new cut of the clip means new frames
    mark = os.path.join(d, ".source")
    if not os.path.isdir(d) or len([f for f in os.listdir(d) if f.endswith(".jpg")]) != n or not os.path.exists(mark) or open(mark).read() != stamp:
        os.makedirs(d, exist_ok=True)
        for f in os.listdir(d):
            os.remove(os.path.join(d, f))
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", os.path.join(work, "track.mp4"), "-q:v", "2", "-start_number", "0",
                        os.path.join(d, "%05d.jpg")], check=True)
        open(mark, "w").write(stamp)
    return d, sorted(f for f in os.listdir(d) if f.endswith(".jpg"))


def steady(masks, W, H, half=4, scale=0.5):
    """Masks that do not shimmer: each frame becomes a weighted average of its neighbours (±half frames), each moved so
    its centre sits on this frame's (the building drifts, its outline should not), on a softened edge; then cut at 0.5.
    Done at `scale` of the size, frame by frame through a small window, so a long clip fits in memory."""
    w, h = max(1, int(W * scale)), max(1, int(H * scale))
    small, cent = {}, {}

    def get(i):
        if i not in small:
            m = masks[i]
            a = cv2.resize(m.astype(np.float32), (w, h), interpolation=cv2.INTER_AREA) if m is not None else np.zeros((h, w), np.float32)
            a = cv2.GaussianBlur(a, (0, 0), 1.2)
            small[i] = a
            ys, xs = np.nonzero(a > 0.5)
            cent[i] = (xs.mean(), ys.mean()) if len(xs) else None
        return small[i]
    out = []
    n = len(masks)
    for i in range(n):
        for k in [k for k in small if k < i - half]:
            small.pop(k); cent.pop(k)
        base = get(i)
        if cent[i] is None:
            out.append(masks[i].astype(np.float32) if masks[i] is not None else None)
            continue
        acc, wsum = np.zeros((h, w), np.float32), 0.0
        for j in range(max(0, i - half), min(n, i + half + 1)):
            a = get(j)
            if cent[j] is None:
                continue
            wt = half + 1 - abs(i - j)
            dx, dy = cent[i][0] - cent[j][0], cent[i][1] - cent[j][1]
            acc += wt * (cv2.warpAffine(a, np.float32([[1, 0, dx], [0, 1, dy]]), (w, h)) if (dx or dy) else a)
            wsum += wt
        # the soft field itself goes out: outlines are traced in it finer than a pixel
        out.append(cv2.resize(acc / max(wsum, 1e-6), (W, H), interpolation=cv2.INTER_LINEAR))
        del base
    return out


def lock(masks, gray, keep=0.82):
    """Outlines that move with the building, not with SAM 2's guesses: each frame's outline is the last one carried along
    by the building's own motion (corners tracked inside it, a similarity transform), nudged toward SAM 2's mask for
    this frame (1 - keep of it), so the shape still follows the view slowly but there is no frame-to-frame shiver.
    Returns soft masks (0..1)."""
    H, W = gray(0).shape
    out, prev, pg = [], None, None
    lk = dict(winSize=(21, 21), maxLevel=3, criteria=(cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 30, 0.01))
    for i, m in enumerate(masks):
        g = gray(i)
        obs = cv2.GaussianBlur(m.astype(np.float32), (0, 0), 1.0) if m is not None else None
        if prev is None or obs is None or obs.max() < 0.5:
            cur = obs if obs is not None else (prev if prev is not None else np.zeros((H, W), np.float32))
        else:
            A = None
            core = cv2.erode((prev > 0.5).astype(np.uint8), np.ones((5, 5), np.uint8))
            pts = cv2.goodFeaturesToTrack(pg, 300, 0.01, 4, mask=core) if core.any() else None
            if pts is not None and len(pts) >= 8:
                nxt, st, _ = cv2.calcOpticalFlowPyrLK(pg, g, pts, None, **lk)
                ok = st.ravel() == 1
                if ok.sum() >= 8:
                    A, _ = cv2.estimateAffinePartial2D(pts[ok], nxt[ok], method=cv2.RANSAC, ransacReprojThreshold=1.5)
            pred = cv2.warpAffine(prev, A, (W, H), flags=cv2.INTER_LINEAR) if A is not None else prev
            cur = keep * pred + (1 - keep) * obs
        out.append(cur)
        prev, pg = cur, g
    return out


def masks_of(seg):
    """Outlines back to masks (to steady an outline file made before)."""
    W, H = seg["w"], seg["h"]
    out = []
    for fr in seg["frames"]:
        if not fr["polys"]:
            out.append(None)
            continue
        m = np.zeros((H, W), np.uint8)
        cv2.fillPoly(m, [np.int32(np.array(p) * [W, H]) for p in fr["polys"]], 1)
        out.append(m.astype(bool))
    return out


def _edge(mask, m=4):
    """Whether a mask touches the edge of the picture (part of the building is out of view, so its area jumps)."""
    return bool(mask[:m].any() or mask[-m:].any() or mask[:, :m].any() or mask[:, -m:].any())


def outline(mask, W, H, up=3):
    """Polygons of a mask (the parts big enough to matter), simplified, in fractions; its top point and area. A soft
    mask (0..1) is traced at `up` times the size around the building, so the outline moves in steps finer than a pixel."""
    soft = mask.dtype != bool
    m = (mask > 0.5).astype(np.uint8) if soft else mask.astype(np.uint8)
    area = int(m.sum())
    polys = []
    if area:
        ys, xs = np.nonzero(m)
        x0, y0 = max(0, xs.min() - 4), max(0, ys.min() - 4)
        x1, y1 = min(W, xs.max() + 5), min(H, ys.max() + 5)
        crop = (mask[y0:y1, x0:x1].astype(np.float32))
        k = up if soft else 1
        big = cv2.resize(crop, ((x1 - x0) * k, (y1 - y0) * k), interpolation=cv2.INTER_LINEAR) if k > 1 else crop
        cs, _ = cv2.findContours((big > 0.5).astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        cs = [c for c in cs if cv2.contourArea(c) > max(60.0, 0.02 * area) * k * k]
        for c in cs:
            a = cv2.approxPolyDP(c, 0.8 * k, True).reshape(-1, 2).astype(np.float64) / k + [x0, y0]
            if len(a) >= 3:
                polys.append([[round(float(x) / W, 5), round(float(y) / H, 5)] for x, y in a])
    top = None
    if area:
        ys, xs = np.nonzero(m)
        y0 = ys.min()
        top = [round(float(np.median(xs[ys <= y0 + 6])) / W, 4), round(float(y0) / H, 4)]
    return polys, top, area


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("work")
    ap.add_argument("--id")
    ap.add_argument("--frame", type=int, default=0)
    ap.add_argument("--points")
    ap.add_argument("--steady", help="an existing seg-*.json to steady (and nothing else)")
    ap.add_argument("--out")
    ap.add_argument("--model", default="small", choices=list(MODELS))
    ap.add_argument("--progress", action="store_true")
    a = ap.parse_args()
    if a.steady:   # an outline file made before: steady it in place, no SAM 2 needed
        seg = json.load(open(a.steady))
        fdir, names = frames_of(a.work)
        gray_of = lambda i: cv2.imread(os.path.join(fdir, names[i]), cv2.IMREAD_GRAYSCALE)  # noqa: E731
        ms = steady([f > 0.5 for f in lock(masks_of(seg), gray_of)], seg["w"], seg["h"], half=2)
        for fr, fd in zip(seg["frames"], ms):
            fr["polys"], fr["top"], fr["area"] = outline(fd if fd is not None else np.zeros((seg["h"], seg["w"]), np.float32), seg["w"], seg["h"])
        seg["steady"] = True
        json.dump(seg, open(a.steady, "w"), separators=(",", ":"))
        print("steadied", a.steady)
        return
    out = a.out or a.work
    os.makedirs(out, exist_ok=True)
    say = (lambda v: print(f"P {v:.3f}", flush=True)) if a.progress else (lambda v: None)

    import torch
    from sam2.build_sam import build_sam2_video_predictor
    cfg, ckpt = MODELS[a.model]
    device = "mps" if torch.backends.mps.is_available() else "cpu"
    pred = build_sam2_video_predictor(cfg, os.path.join(os.environ.get("MAP_SAM_MODELS") or os.path.join(REPO, "models", "sam2"), ckpt), device=device)

    fdir, names = frames_of(a.work)
    n = len(names)
    gray_of = lambda i: cv2.imread(os.path.join(fdir, names[i]), cv2.IMREAD_GRAYSCALE)  # noqa: E731
    first = cv2.imread(os.path.join(fdir, names[0]))
    H, W = first.shape[:2]
    F = max(0, min(n - 1, a.frame))
    # points [x, y, label, object]: several buildings can be followed in one run (one SAM 2 pass for all)
    raw = json.loads(a.points)
    objs = sorted({int(p[3]) if len(p) > 3 else 0 for p in raw})
    prompts = {o: (np.array([[p[0] * W, p[1] * H] for p in raw if (int(p[3]) if len(p) > 3 else 0) == o], np.float32),
                   np.array([int(p[2]) if len(p) > 2 else 1 for p in raw if (int(p[3]) if len(p) > 3 else 0) == o], np.int32)) for o in objs}
    masks = {o: [None] * n for o in objs}
    done = [0]

    def run(idx, start, reverse):
        """One chunk: frames idx (in playing order), started from the clicks (first chunk) or the masks carried over."""
        with tempfile.TemporaryDirectory() as tmp:
            order = idx[::-1] if reverse else idx
            for k, i in enumerate(order):   # SAM 2 plays a folder in name order: number them as this chunk plays
                src, dst = os.path.join(fdir, names[i]), os.path.join(tmp, f"{k:05d}.jpg")
                try:
                    os.symlink(src, dst)
                except OSError:   # Windows without the right to make links
                    shutil.copyfile(src, dst)
            st = pred.init_state(video_path=tmp, offload_video_to_cpu=True, offload_state_to_cpu=True)
            for o in objs:
                if start is None:
                    pred.add_new_points_or_box(st, frame_idx=0, obj_id=o + 1, points=prompts[o][0], labels=prompts[o][1])
                elif start[o] is not None and start[o].any():
                    pred.add_new_mask(st, frame_idx=0, obj_id=o + 1, mask=start[o])
            for k, ids, logits in pred.propagate_in_video(st):
                for j, oid in enumerate(ids):
                    masks[oid - 1][order[k]] = (logits[j, 0] > 0).cpu().numpy()
                done[0] += 1
                say(done[0] / (n + (n // CHUNK)))
            pred.reset_state(st)
        return {o: masks[o][order[-1]] for o in objs}

    with torch.inference_mode():
        # forward from the clicked frame, then backward; each chunk starts one frame back so there is no seam
        m, s = None, F
        while s < n:
            e = min(n, s + CHUNK)
            m = run(list(range(s, e)), m, False)
            s = e - 1 if e < n else n
        m, s = {o: masks[o][F] for o in objs}, F
        while s > 0 and F > 0:
            b = max(0, s - CHUNK + 1)
            m = run(list(range(b, s + 1)), m, True)
            s = b
    summary = []
    for o in objs:
        fields = steady([f > 0.5 for f in lock(masks[o], gray_of)], W, H, half=2)
        frames, iou, weak = [], [], []
        prev = None
        for i, fd in enumerate(fields):
            fd = fd if fd is not None else np.zeros((H, W), np.float32)
            polys, top, area = outline(fd, W, H)
            mk = fd > 0.5
            masks[o][i] = mk
            frames.append({"polys": polys, "top": top, "area": area})
            if prev is not None:
                # a building leaving (or entering) the picture is not a tracking slip: only compare frames that show it
                if mk.sum() > 200 and prev.sum() > 200 and not (_edge(mk) or _edge(prev)):
                    v = float(np.logical_and(mk, prev).sum() / np.logical_or(mk, prev).sum())
                    iou.append(round(v, 3))
                    if v < WEAK_IOU:
                        weak.append(i)
            prev = mk
        sid = f"{a.id}-{o}"
        res = {"w": W, "h": H, "n": n, "frame": F, "points": [p for p in raw if (int(p[3]) if len(p) > 3 else 0) == o], "frames": frames, "iou": iou,
               "weak": weak, "iouMin": min(iou) if iou else 1.0, "iouMedian": float(np.median(iou)) if iou else 1.0}
        json.dump(res, open(os.path.join(out, f"seg-{sid}.json"), "w"), separators=(",", ":"))
        # frames to look at: the mask in colour over the picture
        for tag, i in (("first", 0), ("mid", n // 2), ("last", n - 1)):
            img = cv2.imread(os.path.join(fdir, names[i]))
            mk = masks[o][i] if masks[o][i] is not None else np.zeros((H, W), bool)
            over = img.copy()
            over[mk] = (0.45 * over[mk] + 0.55 * np.array([60, 200, 255])).astype(np.uint8)
            cs, _ = cv2.findContours(mk.astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
            cv2.drawContours(over, cs, -1, (40, 220, 255), 3)
            cv2.imwrite(os.path.join(out, f"seg-{sid}-debug-{tag}.jpg"), cv2.resize(over, (W // 2, H // 2)), [cv2.IMWRITE_JPEG_QUALITY, 85])
        summary.append({"id": sid, "n": n, "iouMin": res["iouMin"], "weak": weak})
    say(1.0)
    print("RESULT " + json.dumps(summary))


if __name__ == "__main__":
    sys.exit(main())
