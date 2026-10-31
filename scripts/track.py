"""Ground tracking for drone footage: one homography per frame, for text and light trails "stuck" to the ground.

    python3 scripts/track.py <clip.mp4> <out.json> [--mask-top 0.45] [--progress]

Corner features are followed (Lucas-Kanade, started where the last frame's motion says they will be, so fast flights
keep them) from a keyframe to the current frame, and one homography per frame is fitted from the keyframe, so error
does not pile up frame by frame. Each new keyframe is first matched (SIFT) straight to the earlier keyframe it overlaps
most, frame 0 included, which takes out the drift that did build up; that correction is spread over the frames since
the last keyframe, so it never shows as a jump. A frame that cannot be tracked is filled in from
its neighbours and reported. out.json: {"w", "h", "fps", "H": [[9 numbers] per frame], "weak": [[first, last], ...],
"quality": "good" | "ok" | "poor"}; H[t] maps a pixel of frame 0 to frame t. Flat ground works best; tall buildings
close to the camera drift a little (parallax).
"""
import json
import sys

import cv2
import numpy as np

SIFT_W = 960          # keyframes are matched at this width
MIN_PTS = 60          # fewer tracked points than this → new keyframe / fallback


def norm(H):
    return H / H[2, 2]


def proj(H, p):
    return cv2.perspectiveTransform(np.asarray(p, np.float32).reshape(-1, 1, 2), H).reshape(-1, 2)


class Matcher:
    """SIFT on small copies; returns a homography in full-size pixels from image a to image b."""

    def __init__(self, w):
        self.s = SIFT_W / w
        self.sift = cv2.SIFT_create(nfeatures=4000)
        self.clahe = cv2.createCLAHE(2.0, (8, 8))

    def feats(self, gray):
        small = cv2.resize(gray, None, fx=self.s, fy=self.s, interpolation=cv2.INTER_AREA)
        k, d = self.sift.detectAndCompute(self.clahe.apply(small), None)
        return (np.float32([q.pt for q in k]) / self.s if k else np.zeros((0, 2), np.float32)), d

    def match(self, fa, fb, guess=None, radius=None):
        (pa, da), (pb, db) = fa, fb
        if da is None or db is None or len(pa) < 8 or len(pb) < 8:
            return None, 0
        m = cv2.BFMatcher().knnMatch(da, db, k=2)
        good = [x[0] for x in m if len(x) == 2 and x[0].distance < 0.8 * x[1].distance]
        a = np.float32([pa[g.queryIdx] for g in good]); b = np.float32([pb[g.trainIdx] for g in good])
        if guess is not None and len(a):   # only matches that agree roughly with where we think things are
            ok = np.linalg.norm(proj(guess, a) - b, axis=1) < radius
            a, b = a[ok], b[ok]
        if len(a) < 12:
            return None, 0
        H, inl = cv2.findHomography(a, b, cv2.USAC_MAGSAC, 3.0, maxIters=10000)
        return (norm(H), int(inl.sum())) if H is not None else (None, 0)


def overlap(H, w, h):
    """Share of frame a that lands inside frame b under H (a → b)."""
    g = np.float32([[x, y] for x in np.linspace(0, w, 7) for y in np.linspace(0, h, 5)])
    q = proj(H, g)
    return float(np.mean((q[:, 0] >= 0) & (q[:, 0] < w) & (q[:, 1] >= 0) & (q[:, 1] < h)))


def main(src, dst, mask_top=0.45, report=False):
    cap = cv2.VideoCapture(src)
    fps = cap.get(cv2.CAP_PROP_FPS)
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT)) or 1
    ok, frame = cap.read()
    if not ok:
        raise SystemExit("cannot read " + src)
    h, w = frame.shape[:2]
    mask = np.zeros((h, w), np.uint8)
    mask[int(h * mask_top):, :] = 255
    lk = dict(winSize=(31, 31), maxLevel=5, criteria=(cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 30, 0.01))
    M = Matcher(w)

    def corners(gray):
        p = cv2.goodFeaturesToTrack(gray, maxCorners=1500, qualityLevel=0.005, minDistance=10, mask=mask, blockSize=7)
        return p.reshape(-1, 2) if p is not None else np.zeros((0, 2), np.float32)

    def refine(a, gray, rel):
        """Precise anchor keyframe → this frame: the keyframe warped into this view by `rel`, then the small leftover
        measured with LK at full size (so a turn or zoom since the keyframe does not matter). None when too few hold."""
        ag = a[2]
        warped = cv2.warpPerspective(ag, rel, (w, h), flags=cv2.INTER_LINEAR)
        valid = cv2.erode((cv2.warpPerspective(np.full_like(ag, 255), rel, (w, h)) > 0).astype(np.uint8) * 255, np.ones((41, 41), np.uint8))
        if cv2.countNonZero(valid) < 0.25 * w * h:
            return None
        p0 = cv2.goodFeaturesToTrack(warped, maxCorners=800, qualityLevel=0.005, minDistance=14, mask=valid & mask, blockSize=7)
        if p0 is None or len(p0) < 30:
            return None
        p0 = p0.reshape(-1, 2)
        nxt, st, _ = cv2.calcOpticalFlowPyrLK(warped, gray, p0, None, winSize=(31, 31), maxLevel=3, criteria=lk["criteria"])
        back, st2, _ = cv2.calcOpticalFlowPyrLK(gray, warped, nxt, None, winSize=(31, 31), maxLevel=3, criteria=lk["criteria"])
        good = (st[:, 0] == 1) & (st2[:, 0] == 1) & (np.linalg.norm(p0 - back, axis=1) < 0.8)
        if good.sum() < 30:
            return None
        C, inl = cv2.findHomography(p0[good], nxt[good], cv2.USAC_MAGSAC, 1.5, maxIters=5000)
        if C is None or inl.sum() < max(30, 0.4 * good.sum()):
            return None
        return norm(C @ rel)

    def locate(gray, guess, cands, radius):
        """This frame straight from the best overlapping keyframe: LK from the guess, else SIFT first, then LK."""
        fb = None
        for a in cands:
            rel = guess @ np.linalg.inv(a[0])
            if overlap(rel, w, h) < 0.3:
                continue
            Hr = refine(a, gray, rel)
            if Hr is None:
                fb = M.feats(gray) if fb is None else fb
                Hm, n = M.match(a[1], fb, rel, radius)
                if Hm is not None and n >= 25:
                    Hr = refine(a, gray, Hm)
                    Hr = Hm if Hr is None else Hr
            if Hr is not None:
                return norm(Hr @ a[0]), a
        return None, None

    def fit(a, gray, H):
        """How well anchor `a` placed by H (frame 0 → this frame) matches this frame: correlation of edges, half size."""
        rel = norm(H @ np.linalg.inv(a[0]))
        S = np.diag([0.5, 0.5, 1.0])
        g2 = cv2.resize(gray, (w // 2, h // 2), interpolation=cv2.INTER_AREA)
        wa = cv2.warpPerspective(cv2.resize(a[2], (w // 2, h // 2), interpolation=cv2.INTER_AREA), S @ rel @ np.linalg.inv(S), (w // 2, h // 2))
        valid = cv2.warpPerspective(np.full((h // 2, w // 2), 1, np.uint8), S @ rel @ np.linalg.inv(S), (w // 2, h // 2)) > 0
        if valid.sum() < 0.1 * valid.size:
            return -1.0
        edge = lambda im: cv2.GaussianBlur(cv2.magnitude(cv2.Sobel(im, cv2.CV_32F, 1, 0), cv2.Sobel(im, cv2.CV_32F, 0, 1)), (0, 0), 1.5)
        x, y = edge(wa)[valid], edge(g2)[valid]
        x, y = x - x.mean(), y - y.mean()
        return float((x * y).sum() / (np.sqrt((x * x).sum() * (y * y).sum()) + 1e-6))

    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    Hs, weak = [np.eye(3)], [False]
    # keyframes: (frame 0 → keyframe, SIFT features, picture, corners)
    anchors = [(np.eye(3), M.feats(gray), gray, corners(gray))]
    kf_H, kf_pts = np.eye(3), corners(gray)          # current keyframe and its corners
    cur, kf_n = kf_pts.copy(), len(kf_pts)             # where those corners are now
    prev, step, since = gray, np.eye(3), 0
    # drift taken out at a keyframe: (previous keyframe, this frame, correction). It built up over the frames in
    # between, so it is spread back over them afterwards instead of landing as a jump on one frame
    fixes, kf_i = [], 0
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        guess = norm(step @ Hs[-1])                   # the motion keeps going
        H, bad = None, False
        if len(cur) >= 8:
            pred = proj(step, cur)
            nxt, st, _ = cv2.calcOpticalFlowPyrLK(prev, gray, cur, pred.copy(), flags=cv2.OPTFLOW_USE_INITIAL_FLOW, **lk)
            back, st2, _ = cv2.calcOpticalFlowPyrLK(gray, prev, nxt, None, **lk)
            good = (st[:, 0] == 1) & (st2[:, 0] == 1) & (np.linalg.norm(cur - back, axis=1) < 0.8)
            if good.sum() >= 12:
                Hk, inl = cv2.findHomography(kf_pts[good], nxt[good], cv2.USAC_MAGSAC, 2.0, maxIters=5000)
                if Hk is not None and inl.sum() >= 12:
                    keep = good.copy(); keep[good] = inl.ravel() > 0
                    kf_pts, cur, H = kf_pts[keep], nxt[keep], norm(Hk @ kf_H)
        if H is None or len(cur) < MIN_PTS:
            # lost most points (fast move, blur): find this frame straight from the nearest keyframe
            near = sorted(anchors, key=lambda a: -overlap(guess @ np.linalg.inv(a[0]), w, h))[:2]
            Hl, a = locate(gray, guess if H is None else H, near, 0.15 * w)
            if Hl is not None and (H is None or fit(a, gray, Hl) > fit(a, gray, H)):
                H = Hl
            elif H is None:
                H, bad = guess, True
        # new keyframe when the old one is wearing out or getting old; re-anchor it first to take out drift
        since += 1
        if not bad and (len(cur) < 0.45 * kf_n or len(cur) < 2 * MIN_PTS or since >= 20):
            # the oldest overlapping keyframe carries the least drift (frame 0 has none)
            old = [a for a in anchors if overlap(H @ np.linalg.inv(a[0]), w, h) >= 0.4][:2]
            Ha, a = locate(gray, H, old, 0.06 * w) if old else (None, None)
            # take it only as a correction that really lines things up better, not a jump somewhere else
            g = np.float32([[w * x, h * y] for x in (0.2, 0.5, 0.8) for y in (0.2, 0.5, 0.8)])
            if Ha is not None and np.abs(proj(Ha, g) - proj(H, g)).max() < 0.05 * w and fit(a, gray, Ha) > fit(a, gray, H) + 0.01:
                fixes.append((kf_i, len(Hs), norm(Ha @ np.linalg.inv(H))))
                H = Ha
            kf_H, kf_pts, kf_i = H, corners(gray), len(Hs)
            cur, kf_n = kf_pts.copy(), len(kf_pts)
            anchors.append((H, M.feats(gray), gray, kf_pts.copy()))
            since = 0
        step = norm(H @ np.linalg.inv(Hs[-1]))
        Hs.append(H)
        if report and len(Hs) % 5 == 0:   # "P done total" lines for whoever runs us
            print(f"P {len(Hs)} {total}", flush=True)
        weak.append(bad)
        prev = gray
    corner = np.float32([[0, 0], [w, 0], [w, h], [0, h]])
    for a, b, C in fixes:
        moved = proj(C, corner)
        for i in range(a + 1, b):
            u = (i - a) / (b - a)
            Hs[i] = norm(cv2.getPerspectiveTransform(corner, np.float32(corner + (moved - corner) * u)) @ Hs[i])
    # frames that could not be tracked: in between the good ones around them
    n = len(Hs)
    g = np.float32([[0, 0], [w, 0], [w, h], [0, h]])
    runs, i = [], 0
    while i < n:
        if weak[i]:
            j = i
            while j + 1 < n and weak[j + 1]:
                j += 1
            runs.append([i, j])
            a, b = i - 1, j + 1
            if b < n:
                pa, pb = proj(Hs[a], g), proj(Hs[b], g)
                for k in range(i, j + 1):
                    u = (k - a) / (b - a)
                    Hs[k] = norm(cv2.getPerspectiveTransform(g, np.float32(pa + (pb - pa) * u)))
            i = j + 1
        else:
            i += 1
    share = sum(b - a + 1 for a, b in runs) / n
    quality = "good" if share == 0 else "ok" if share < 0.05 else "poor"
    json.dump({"w": w, "h": h, "fps": fps, "H": [norm(H).flatten().tolist() for H in Hs], "weak": runs, "quality": quality}, open(dst, "w"))
    print(f"track: {n} frames, {len(anchors)} keyframes, {sum(b - a + 1 for a, b in runs)} weak frames, {quality} → {dst}")


if __name__ == "__main__":
    args = sys.argv[1:]
    top = float(args[args.index("--mask-top") + 1]) if "--mask-top" in args else 0.45
    rest = [x for i, x in enumerate(args) if x not in ("--mask-top", "--progress") and (i == 0 or args[i - 1] != "--mask-top")]
    main(rest[0], rest[1], top, "--progress" in args)
