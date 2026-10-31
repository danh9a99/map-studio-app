"""Real roads, road names and highlighted areas on aerial footage, for any clip (drone, phone, stock).

    python3 scripts/drone-map.py prep  <clip> --name <n> [--start 0] [--dur 8] [--center lat,lon]
    python3 scripts/drone-map.py place --name <n> --center lat,lon
    python3 scripts/drone-map.py fit   --name <n> [--pairs '[[fx,fy,lat,lon], …]']
    python3 scripts/drone-map.py build --name <n> --plan '<json>'

Work folder: output/drone/<n>/.
prep  cuts the stretch (long side 1920 px, 30 fps), tracks the ground over it (track.py), saves the first frame
      (frame.jpg) and reads DJI flight data when the file has it (GPS, height, gimbal). It downloads Esri World
      Imagery tiles around the place (--center, else the drone's GPS) into a mosaic the user clicks on (sat.jpg) and
      OpenStreetMap roads and areas around it (osm.json, Overpass). Without a place (no --center, no GPS in the
      file) it stops at "need-place" and `place` does that part later. Prints meta.json.
fit   places the map on the first frame: from 3–4 pairs (a point on the frame ↔ the same point on the map), or from
      the DJI flight data when there are no pairs; then tightens it by matching the satellite image, pre-warped to
      the camera's view, against the frame (SIFT). Writes map2img.npy and fit.json: every named road and area seen
      in the frame, projected, for the picker to show.
start prep + place + (DJI) fit + Claude's draft + colour, in one go; `points`, `place-go`, `draft`, `color`, `render`
      are the later steps of the map editor (map.json, rendered by the MapShot composition).
build turns the user's choices into the TrackedShot overlay and renders: plan = {"roads": [{"name", "color",
      "label"}], "areas": [{"name"? (an OSM area) | "points" (fractions of the frame), "label"}], "aspect": "16:9" |
      "9:16", "theme": "gold" | "mint", "title"?}. Writes video.mp4 (status in status.json).
Satellite imagery is only used to match, never shown in the video; OSM data is credited on screen.
"""
import glob
import json
import math
import os
import re
import shutil
import struct
import subprocess
import sys
import time

import cv2
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
REMOTION = os.path.dirname(HERE)   # the project root (Remotion sources in src/)
REPO = REMOTION
# the desktop app keeps its runs and the render's public folder in the user's data folder
ROOT = os.environ.get("MAP_ROOT", REPO)
PUBLIC = os.environ.get("MAP_PUBLIC", os.path.join(REMOTION, "public"))
UA = "video-studio/0.1 (local video tool)"
Z = 18          # satellite zoom (≈0.6 m per pixel here)
TILES = 11      # mosaic is TILES × TILES tiles (≈1.7 km across)
OVERPASS = ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter", "https://overpass.private.coffee/api/interpreter"]


def work(name):
    d = os.path.join(ROOT, "output", "drone", name)
    os.makedirs(d, exist_ok=True)
    return d


# the job this run belongs to: its title and stages, so the editor's progress window can show where it is
JOB = {}
_LAST = {"step": None, "kw": {}, "at": 0.0}


def job(title, stages):
    """A run starts: `stages` = [(step, label), ...] in order. status() then says which one is going."""
    JOB.clear()
    JOB.update(title=title, stages=stages, started=time.time())


def status(d, step, pct=None, **kw):
    extra = {}
    if JOB:
        keys = [k for k, _ in JOB["stages"]]
        extra = {"job": JOB["title"], "stages": [lb for _, lb in JOB["stages"]], "started": JOB["started"]}
        if step in keys:
            extra["stage"] = keys.index(step)
        elif step in ("ready", "done"):
            extra["stage"] = len(keys)
        elif _LAST.get("stage") is not None:   # an in-between step ("fitted"): still that stage
            extra["stage"] = _LAST["stage"]
        _LAST["stage"] = extra.get("stage")
    if pct is not None:
        extra["pct"] = round(max(0.0, min(1.0, pct)), 3)
    _LAST.update(step=step, kw=kw, d=d)
    # written whole then swapped in: the server polls it several times a second and must never read half a file
    body = json.dumps({"step": step, "time": time.time(), **extra, **kw}, ensure_ascii=False)
    tmp, dst = os.path.join(d, "status.json.tmp"), os.path.join(d, "status.json")
    with open(tmp, "w") as f:
        f.write(body)
    # Windows refuses the swap while another program holds the file a moment (an antivirus scan, the server's read)
    for i in range(20):
        try:
            os.replace(tmp, dst)
            return
        except PermissionError:
            time.sleep(0.05 * (i + 1))
    with open(dst, "w") as f:
        f.write(body)


def discard(p):
    """Remove a file the editor may still be playing: Windows will not delete it then, and a stale copy does no harm."""
    try:
        os.remove(p)
    except OSError:
        pass


def progress(pct, msg=None):
    """How far the current stage is (0..1), at most a few times a second."""
    now = time.time()
    if not _LAST.get("d") or (now - _LAST["at"] < 0.4 and pct < 1):
        return
    _LAST["at"] = now
    kw = {**_LAST["kw"], **({"msg": msg} if msg else {})}
    status(_LAST["d"], _LAST["step"], pct=pct, **kw)


def run_progress(cmd, parse, **popen):
    """Run a command, feed each output line to `parse` (→ a fraction or None) and report it; raise on failure."""
    p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1, **popen)
    tail = []
    for line in p.stdout:
        for part in line.replace("\r", "\n").split("\n"):
            if part.strip():
                tail = (tail + [part])[-40:]
                v = parse(part)
                if v is not None:
                    progress(v)
    if p.wait():
        raise RuntimeError("\n".join(tail)[-600:])
    return tail


def ffmpeg_pct(dur, lo=0.0, hi=1.0):
    """For ffmpeg run with -progress pipe:1: the share of `dur` seconds written, mapped into [lo, hi]."""
    def parse(line):
        if line.startswith("out_time_us=") and line[12:].strip().lstrip("-").isdigit():
            return lo + (hi - lo) * min(1.0, int(line[12:]) / 1e6 / max(0.1, dur))
        return None
    return parse


# ── geography ────────────────────────────────────────────────────────────────
class Geo:
    """Local metres around a centre (x east, y south), Web Mercator tiles of the mosaic."""

    def __init__(self, lat0, lon0, tx0=None, ty0=None):
        self.lat0, self.lon0 = lat0, lon0
        n = 2 ** Z
        cx = (lon0 + 180) / 360 * n
        cy = (1 - math.asinh(math.tan(math.radians(lat0))) / math.pi) / 2 * n
        self.tx0 = int(cx) - TILES // 2 if tx0 is None else tx0
        self.ty0 = int(cy) - TILES // 2 if ty0 is None else ty0

    def xy(self, lat, lon):
        return np.array(((lon - self.lon0) * 111320 * math.cos(math.radians(self.lat0)), -(lat - self.lat0) * 110540))

    def ll_of_xy(self, x, y):
        return self.lat0 - y / 110540, self.lon0 + x / (111320 * math.cos(math.radians(self.lat0)))

    def ll_of_px(self, px, py):
        n = 2 ** Z
        X, Y = self.tx0 + px / 256, self.ty0 + py / 256
        return math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * Y / n)))), X / n * 360 - 180

    def px_of_ll(self, lat, lon):
        n = 2 ** Z
        return ((lon + 180) / 360 * n - self.tx0) * 256, ((1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * n - self.ty0) * 256

    def sat2map(self):
        P = [(0, 0), (TILES * 256, 0), (0, TILES * 256)]
        A = cv2.getAffineTransform(np.float32(P), np.float32([self.xy(*self.ll_of_px(*p)) for p in P]))
        return np.vstack([A, [0, 0, 1]])


def get(url, data=None, timeout=60):
    args = ["curl", "-sfL", "-m", str(timeout), "-A", UA, url]
    if data is not None:
        args[1:1] = ["--data-urlencode", "data=" + data]
    return subprocess.run(args, capture_output=True, check=True).stdout


def fetch_sat(d, g):
    tiles = os.path.join(d, "tiles")
    os.makedirs(tiles, exist_ok=True)
    from PIL import Image
    im = Image.new("RGB", (TILES * 256, TILES * 256))
    for dx in range(TILES):
        for dy in range(TILES):
            f = os.path.join(tiles, f"{Z}_{g.tx0 + dx}_{g.ty0 + dy}.jpg")
            if not os.path.exists(f):
                try:
                    open(f, "wb").write(get(f"https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{Z}/{g.ty0 + dy}/{g.tx0 + dx}", timeout=30))
                except subprocess.CalledProcessError:
                    continue
            try:
                im.paste(Image.open(f), (dx * 256, dy * 256))
            except Exception:
                pass
    im.save(os.path.join(d, "sat.jpg"), quality=90)


def osm_api(lat, lon, r):
    """Fallback when every Overpass server is down: the main OSM API's map call (XML), turned into the same
    shape as Overpass 'out geom' (ways with their tags and node coordinates)."""
    import xml.etree.ElementTree as ET
    dlat = r / 110540; dlon = r / (111320 * math.cos(math.radians(lat)))
    xml = get(f"https://api.openstreetmap.org/api/0.6/map?bbox={lon - dlon:.6f},{lat - dlat:.6f},{lon + dlon:.6f},{lat + dlat:.6f}", timeout=120)
    root = ET.fromstring(xml)
    nodes = {n.get("id"): (float(n.get("lat")), float(n.get("lon"))) for n in root.iter("node")}
    els = []
    for w in root.iter("way"):
        tags = {t.get("k"): t.get("v") for t in w.iter("tag")}
        if not (tags.get("highway") or (tags.get("name") and any(k in tags for k in ("leisure", "place", "landuse", "building", "amenity")))):
            continue
        geom = [{"lat": nodes[n.get("ref")][0], "lon": nodes[n.get("ref")][1]} for n in w.iter("nd") if n.get("ref") in nodes]
        if len(geom) > 1:
            els.append({"type": "way", "id": int(w.get("id")), "tags": tags, "geometry": geom})
    return json.dumps({"elements": els}).encode()


def osm_cached(lat, lon, r):
    """OSM data already fetched for another clip of the same place (its circle covers ours)."""
    for f in sorted(glob.glob(os.path.join(ROOT, "output", "drone", "*", "osm.json")), key=os.path.getmtime, reverse=True):
        try:
            m = json.load(open(os.path.join(os.path.dirname(f), "meta.json")))
            c = m.get("center")
            if c and os.path.getsize(f) > 1000:
                dist = math.hypot((c[0] - lat) * 110540, (c[1] - lon) * 111320 * math.cos(math.radians(lat)))
                if dist + r * 0.6 <= m.get("osmRadius", 900):
                    return open(f, "rb").read()
        except Exception:
            continue
    return None


def fetch_osm(d, lat, lon, r=900):
    q = (f'[out:json][timeout:60];(way["highway"](around:{r},{lat},{lon});way["name"]["leisure"](around:{r},{lat},{lon});'
         f'way["name"]["place"](around:{r},{lat},{lon});way["name"]["landuse"](around:{r},{lat},{lon});'
         f'way["name"]["building"](around:{r},{lat},{lon});way["name"]["amenity"](around:{r},{lat},{lon}););out geom tags;')
    # the public Overpass servers drop connections when busy: try each mirror twice before giving up
    last = None
    for attempt in range(2):
        for url in OVERPASS:
            try:
                data = get(url, data=q, timeout=120)
                if data.lstrip().startswith(b"{"):
                    open(os.path.join(d, "osm.json"), "wb").write(data)
                    return
            except subprocess.CalledProcessError as e:
                last = e
        time.sleep(3)
    cached = osm_cached(lat, lon, r)
    if cached:
        open(os.path.join(d, "osm.json"), "wb").write(cached)
        return
    try:
        open(os.path.join(d, "osm.json"), "wb").write(osm_api(lat, lon, min(r, 750)))
        return
    except Exception:
        pass
    raise RuntimeError("Không tải được dữ liệu bản đồ: máy chủ OpenStreetMap không phản hồi. Bấm Thử lại sau ít phút."
                       + (f" (curl {last.returncode})" if last else ""))


# ── DJI flight data ──────────────────────────────────────────────────────────
def dji_flight(clip):
    """Per-frame GPS, height (m) and gimbal quaternion from a DJI 'djmd' metadata stream, or None."""
    probe = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "stream=index,codec_tag_string", "-of", "csv=p=0", clip],
                           capture_output=True, text=True).stdout
    idx = next((ln.split(",")[0] for ln in probe.splitlines() if ln.endswith("djmd")), None)
    if idx is None:
        return None
    b = subprocess.run(["ffmpeg", "-v", "error", "-i", clip, "-map", f"0:{idx}", "-c", "copy", "-f", "data", "-"], capture_output=True).stdout
    quat = re.compile(rb"\x0d(.{4})\x15(.{4})\x1d(.{4})\x25(.{4})", re.S)
    alt = re.compile(rb"\x2a\x07\x0d(.{4})", re.S)
    out = []
    for m in re.finditer(rb"\x11(.{8})\x19(.{8})", b, re.S):
        lat, lon = struct.unpack("<d", m.group(1))[0], struct.unpack("<d", m.group(2))[0]
        if not (-90 < lat < 90 and -180 < lon < 180) or (lat == 0 and lon == 0):
            continue
        q, a = quat.search(b, m.end(), m.end() + 400), alt.search(b, m.end(), m.end() + 60)
        if q is None:
            continue
        out.append({"lat": lat, "lon": lon, "h": (struct.unpack("<f", a.group(1))[0] / 1000) if a else None,
                    "q": [struct.unpack("<f", x)[0] for x in q.groups()]})
    return out or None


def ypr(q):
    w, x, y, z = q
    pitch = math.degrees(math.asin(max(-1, min(1, 2 * (w * y - z * x)))))
    yaw = math.degrees(math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z)))
    return yaw, pitch


def cam_H(g, W, H, cx, cy, yaw, pitch, h, hfov, roll=0.0):
    """Map metres → frame pixels for a pinhole camera at map point (cx, cy), h metres up, looking along yaw
    (clockwise from north) and pitch (negative: below the horizon)."""
    f = (W / 2) / math.tan(math.radians(hfov) / 2)
    K = np.array([[f, 0, W / 2], [0, f, H / 2], [0, 0, 1]])
    ya, pi = math.radians(yaw), math.radians(pitch)
    fwd = np.array([math.sin(ya) * math.cos(pi), math.cos(ya) * math.cos(pi), math.sin(pi)])
    right = np.array([math.cos(ya), -math.sin(ya), 0])
    down = np.cross(fwd, right)
    r = math.radians(roll)
    right, down = right * math.cos(r) + down * math.sin(r), -right * math.sin(r) + down * math.cos(r)
    M = np.array([[1, 0, -cx], [0, -1, cy], [0, 0, -h]])
    Hm = K @ np.vstack([right, down, fwd]) @ M
    return Hm / Hm[2, 2]


# ── steps ────────────────────────────────────────────────────────────────────
def cut_track(clip, start, dur, mp4, out_json, lo=0.0, hi=1.0):
    """A stretch of the clip at 30 fps, long side 1920, and its ground track (progress over [lo, hi] of the stage)."""
    pr = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height:stream_side_data=rotation",
                         "-of", "csv=p=0", clip], capture_output=True, text=True)
    size = pr.stdout.strip().split("\n")[0].split(",")[:2]
    if len(size) < 2 or not all(v.strip().isdigit() for v in size):
        raise RuntimeError(f"Không đọc được kích thước video: {(pr.stderr or pr.stdout).strip()[-300:] or 'ffprobe không trả lời'}")
    vw, vh = map(int, size)
    rot = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream_side_data=rotation", "-of", "csv=p=0", clip],
                         capture_output=True, text=True).stdout.strip()
    if rot and abs(int(float(rot.split(",")[0] or 0))) % 180 == 90:
        vw, vh = vh, vw
    scale = "scale=1920:-2" if vw >= vh else "scale=-2:1920"
    mid = lo + (hi - lo) * 0.45   # cutting from the 6K original takes about as long as tracking
    run_progress(["ffmpeg", "-loglevel", "error", "-nostats", "-progress", "pipe:1", "-y", "-ss", str(start), "-t", str(dur), "-i", clip, "-an",
                  "-vf", f"fps=30,{scale}", "-c:v", "libx264", "-crf", "16", "-preset", "fast", "-pix_fmt", "yuv420p", mp4], ffmpeg_pct(dur, lo, mid))
    run_progress([sys.executable, os.path.join(HERE, "track.py"), mp4, out_json, "--mask-top", "0.0", "--progress"],
                  lambda ln: mid + (hi - mid) * int(ln.split()[1]) / max(1, int(ln.split()[2])) if ln.startswith("P ") else None)
    return json.load(open(out_json))


def clip_duration(clip):
    return float(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", clip], capture_output=True, text=True).stdout)


def track_quality(tr):
    """stretches the tracker could not follow (filled in from both sides), in seconds: the editor warns about them"""
    return {"quality": tr.get("quality", "good"), "weak": [[round(a / 30, 2), round((b + 1) / 30, 2)] for a, b in tr.get("weak", [])]}


def cmd_prep(clip, name, start, dur, center):
    d = work(name)
    status(d, "prep", msg="Cắt đoạn và bám chuyển động")
    track = os.path.join(d, "track.mp4")
    tr = cut_track(clip, start, dur, track, os.path.join(d, "track.json"))
    subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-i", track, "-frames:v", "1", "-q:v", "2", os.path.join(d, "frame.jpg")], check=True)
    W_, H_ = cv2.imread(os.path.join(d, "frame.jpg")).shape[1::-1]
    fl = dji_flight(clip)
    rec = None
    if fl:
        per = len(fl) / clip_duration(clip)
        rec = fl[min(len(fl) - 1, int(start * per))]
    if center is None and rec:
        center = (rec["lat"], rec["lon"])
    meta = {"clip": clip, "start": start, "dur": dur, "clipDur": clip_duration(clip), "w": W_, "h": H_, "flight": rec, "track": track_quality(tr)}
    json.dump(meta, open(os.path.join(d, "meta.json"), "w"), ensure_ascii=False)
    if center:
        cmd_place(name, center)
    else:
        status(d, "need-place", msg="Clip không có toạ độ: cho biết nơi quay")
    print(json.dumps(meta, ensure_ascii=False))


def cmd_place(name, center):
    """Satellite mosaic + OSM data around the place the clip shows."""
    d = work(name)
    meta = json.load(open(os.path.join(d, "meta.json")))
    status(d, "place", msg="Tải ảnh vệ tinh và bản đồ")
    g = Geo(*center)
    fetch_sat(d, g)
    fetch_osm(d, *center)
    meta.update(center=list(center), tiles=[g.tx0, g.ty0], zoom=Z, tilesAcross=TILES, osmRadius=900)
    json.dump(meta, open(os.path.join(d, "meta.json"), "w"), ensure_ascii=False)
    status(d, "prepped")


def sift_refine(sat, frame, H, pairs_map=None, pairs_img=None, rounds=((220, 4.0), (90, 3.0), (40, 2.5))):
    """Tighten a satellite-pixel → frame homography by matching the satellite warped to the camera's view.
    User pairs (if any) are kept as heavy constraints. Returns (H, number of satellite matches used)."""
    W_, H_ = frame.shape[1], frame.shape[0]
    clahe = cv2.createCLAHE(2.0, (8, 8))
    sift = cv2.SIFT_create(nfeatures=15000)
    k2, d2 = sift.detectAndCompute(clahe.apply(cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)), None)
    used = 0
    for rad, thr in rounds:
        warped = cv2.warpPerspective(sat, H, (W_, H_))
        mask = (cv2.warpPerspective(np.full(sat.shape[:2], 255, np.uint8), H, (W_, H_)) > 0).astype(np.uint8) * 255
        k1, d1 = sift.detectAndCompute(clahe.apply(cv2.cvtColor(warped, cv2.COLOR_BGR2GRAY)), mask)
        if d1 is None or len(k1) < 10:
            break
        m = cv2.BFMatcher().knnMatch(d1, d2, k=2)
        good = [a for a, b in m if a.distance < 0.85 * b.distance]
        if len(good) < 8:
            break
        p1 = np.float32([k1[a.queryIdx].pt for a in good])
        p2 = np.float32([k2[a.trainIdx].pt for a in good])
        near = np.linalg.norm(p1 - p2, axis=1) < rad
        if near.sum() < 8:
            break
        src = cv2.perspectiveTransform(p1[near].reshape(-1, 1, 2).astype(np.float64), np.linalg.inv(H)).reshape(-1, 2)
        dst = p2[near].astype(np.float64)
        _, inl = cv2.findHomography(src, dst, cv2.USAC_MAGSAC, thr * 2, maxIters=20000)
        if inl is None or inl.sum() < 8:
            break
        src, dst = src[inl.ravel() > 0], dst[inl.ravel() > 0]
        used = len(src)
        if pairs_map is not None and len(pairs_map):
            rep = max(4, used // len(pairs_map))
            src = np.vstack([src] + [pairs_map] * rep)
            dst = np.vstack([dst] + [pairs_img] * rep)
        Hn, _ = cv2.findHomography(src, dst, 0)
        if Hn is None:
            break
        H = Hn
    return H, used


def nelder_mead(cost, v0, step, iters=1500):
    n = len(v0)
    sim = [v0] + [v0 + np.eye(n)[i] * step[i] for i in range(n)]
    fs = [cost(v) for v in sim]
    for _ in range(iters):
        o = np.argsort(fs); sim = [sim[i] for i in o]; fs = [fs[i] for i in o]
        c = np.mean(sim[:-1], axis=0); xr = c + (c - sim[-1]); fr = cost(xr)
        if fr < fs[0]:
            xe = c + 2 * (c - sim[-1]); fe = cost(xe); sim[-1], fs[-1] = (xe, fe) if fe < fr else (xr, fr)
        elif fr < fs[-2]:
            sim[-1], fs[-1] = xr, fr
        else:
            xc = c + 0.5 * (sim[-1] - c); fc = cost(xc)
            if fc < fs[-1]:
                sim[-1], fs[-1] = xc, fc
            else:
                sim = [sim[0]] + [sim[0] + 0.5 * (x - sim[0]) for x in sim[1:]]; fs = [cost(x) for x in sim]
    i = int(np.argmin(fs))
    return sim[i], fs[i]


def camera_solve(g, sat, frame, Hsat, S2M, v0, cx, cy):
    """Solve a real camera (yaw, pitch, roll, height, fov, position shift) to the satellite matches of the current
    fit, so the far part of the shot stays in perspective instead of whatever a free homography does."""
    W_, H_ = frame.shape[1], frame.shape[0]
    clahe = cv2.createCLAHE(2.0, (8, 8)); sift = cv2.SIFT_create(nfeatures=15000)
    k2, d2 = sift.detectAndCompute(clahe.apply(cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)), None)
    warped = cv2.warpPerspective(sat, Hsat, (W_, H_))
    mask = (cv2.warpPerspective(np.full(sat.shape[:2], 255, np.uint8), Hsat, (W_, H_)) > 0).astype(np.uint8) * 255
    k1, d1 = sift.detectAndCompute(clahe.apply(cv2.cvtColor(warped, cv2.COLOR_BGR2GRAY)), mask)
    m = cv2.BFMatcher().knnMatch(d1, d2, k=2)
    good = [a for a, b in m if a.distance < 0.9 * b.distance]
    p1 = np.float32([k1[a.queryIdx].pt for a in good]); p2 = np.float32([k2[a.trainIdx].pt for a in good])
    ok = np.linalg.norm(p1 - p2, axis=1) < 25
    if ok.sum() < 8:
        return None, 0
    mp = proj(S2M @ np.linalg.inv(Hsat), p1[ok]); fp = p2[ok].astype(np.float64)

    def H_of(v):
        return cam_H(g, W_, H_, cx + v[5], cy + v[6], v[0], v[1], v[3], v[4], v[2])

    def cost(v):
        return float(np.mean(np.minimum(np.linalg.norm(proj(H_of(v), mp) - fp, axis=1), 40) ** 2))
    v, f = nelder_mead(cost, np.array(v0, float), np.array([3, 3, 2, 15, 6, 15, 15.0]))
    return H_of(v), int(ok.sum())


def ecc_refine(sat, frame, Hsat):
    """Last nudge: line up the edges of the satellite (as the fit sees it) with the frame's, coarse then fine, so the
    roads sit on the asphalt instead of beside it. Returns the correction (frame → frame) and how well it matched."""
    W_, H_ = frame.shape[1], frame.shape[0]

    def edges(img):
        gr = cv2.createCLAHE(3.0, (8, 8)).apply(cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)).astype(np.float32)
        e = cv2.GaussianBlur(cv2.magnitude(cv2.Sobel(gr, cv2.CV_32F, 1, 0), cv2.Sobel(gr, cv2.CV_32F, 0, 1)), (0, 0), 2)
        return e / (e.mean() + 1e-6)
    C, cc = np.eye(3, dtype=np.float32), 0.0
    for sc in (0.25, 0.5):
        w, h = int(W_ * sc), int(H_ * sc)
        S = np.diag([sc, sc, 1]).astype(np.float32)
        warped = cv2.warpPerspective(sat, S @ Hsat, (w, h))
        mask = cv2.erode((cv2.warpPerspective(np.full(sat.shape[:2], 255, np.uint8), S @ Hsat, (w, h)) > 0).astype(np.uint8), np.ones((9, 9), np.uint8))
        try:
            cc, Cs = cv2.findTransformECC(edges(cv2.resize(frame, (w, h))), edges(warped), (S @ C @ np.linalg.inv(S)).astype(np.float32),
                                          cv2.MOTION_HOMOGRAPHY, (cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 200, 1e-5), mask, 5)
        except cv2.error:
            return None, 0.0
        C = (np.linalg.inv(S) @ Cs @ S).astype(np.float32)
    corners = np.float32([[0, 0], [W_, 0], [W_, H_], [0, H_]])
    moved = np.linalg.norm(proj(np.linalg.inv(C), corners) - corners, axis=1).max()
    return (np.linalg.inv(C), float(cc)) if moved < 0.2 * W_ else (None, float(cc))


def cmd_fit(name, pairs):
    d = work(name)
    meta = json.load(open(os.path.join(d, "meta.json")))
    status(d, "fit", msg="Khớp bản đồ vào khung hình")
    g = Geo(*meta["center"], *meta["tiles"])
    sat, frame = cv2.imread(os.path.join(d, "sat.jpg")), cv2.imread(os.path.join(d, "frame.jpg"))
    S2M = g.sat2map()
    W_, H_ = frame.shape[1], frame.shape[0]
    pm = pi = None
    if pairs:
        pm = np.array([g.px_of_ll(p[2], p[3]) for p in pairs], float)   # satellite pixels
        pi = np.array([[p[0] * W_, p[1] * H_] for p in pairs], float)   # frame pixels
        H0 = cv2.findHomography(pm, pi, 0)[0] if len(pairs) >= 4 else np.vstack([cv2.getAffineTransform(np.float32(pm[:3]), np.float32(pi[:3])), [0, 0, 1]])
        how = f"{len(pairs)} điểm"
    elif meta.get("flight"):
        r = meta["flight"]
        yaw, pitch = ypr(r["q"])
        c = g.xy(r["lat"], r["lon"])
        H0 = cam_H(g, W_, H_, c[0], c[1], yaw, pitch, r["h"] or 150, 70) @ S2M
        how = "dữ liệu bay"
    else:
        raise SystemExit("Cần 3–4 cặp điểm (clip này không có dữ liệu bay)")
    H, used = sift_refine(sat, frame, H0, pm, pi)
    Hmap_cam = None
    if not pairs:
        Hmap_cam, n_cam = camera_solve(g, sat, frame, H, S2M, [yaw, pitch, 0.0, r["h"] or 150, 70, 0, 0], c[0], c[1])
        if Hmap_cam is not None:
            used = n_cam
    err = None
    if pairs:
        q = cv2.perspectiveTransform(pm.reshape(-1, 1, 2), H).reshape(-1, 2)
        err = float(np.mean(np.linalg.norm(q - pi, axis=1)))
        if err > 40:  # the satellite pulled it away from the user's points: trust the points
            H, used = H0, 0
            q = cv2.perspectiveTransform(pm.reshape(-1, 1, 2), H).reshape(-1, 2)
            err = float(np.mean(np.linalg.norm(q - pi, axis=1)))
    Hmap = Hmap_cam if Hmap_cam is not None else H @ np.linalg.inv(S2M)
    edge_match, physical = 0.0, False
    if pairs and len(pairs) >= 4:
        # 4 points fit a free homography exactly, but it need not be a camera: far from the points it bends, roads
        # behind the drone flip into the sky, buildings lean. A real camera through the points generalises.
        Hc, ec = camera_from_pairs(np.array([g.xy(p[2], p[3]) for p in pairs]), pi, W_, H_)
        if Hc is not None and ec <= max(20.0, (err or 0) + 15):
            Hmap, err, physical = Hc, ec, True
    C, edge_match = (None, 0.0) if physical else ecc_refine(sat, frame, Hmap @ S2M)
    if C is not None and edge_match > 0.3:
        Hn = C @ Hmap
        if pairs:  # never at the cost of the user's own points
            q = proj(Hn @ S2M, pm)
            e2 = float(np.mean(np.linalg.norm(q - pi, axis=1)))
            if e2 <= max(25.0, err * 1.3):
                Hmap, err = Hn, e2
        else:
            Hmap = Hn
    np.save(os.path.join(d, "map2img.npy"), Hmap)
    # how far from the anchors the fit can be trusted: around the picked points (or the drone) only
    if pairs:
        mm = np.array([g.xy(p[2], p[3]) for p in pairs])
        # a real camera holds further from the points than a free fit
        c0 = mm.mean(0); reach = max(250.0 if physical else 120.0, (3.0 if physical else 1.8) * float(np.max(np.linalg.norm(mm - c0, axis=1))))
        spread = float(np.ptp(pi[:, 0]) / W_), float(np.ptp(pi[:, 1]) / H_)
    else:
        c0 = g.xy(r["lat"], r["lon"]); reach = 4.0 * (r["h"] or 150); spread = (1.0, 1.0)
    trust = {"center": [round(float(c0[0]), 1), round(float(c0[1]), 1)], "reach": round(reach)}
    roads, areas = visible(d, g, Hmap, W_, H_, trust)
    warn = "Các điểm đang dồn vào một chỗ: chọn thêm điểm ở gần mép trên và mép dưới của khung hình" if min(spread) < 0.35 else None
    fit = {"how": how, "satMatches": used, "edgeMatch": round(edge_match, 3), "pairError": err, "camera": physical, "trust": trust, "warn": warn,
           "pairs": pairs or None, "roads": roads, "areas": areas}
    json.dump(fit, open(os.path.join(d, "fit.json"), "w"), ensure_ascii=False)
    status(d, "fitted")
    print(json.dumps({k: v for k, v in fit.items() if k not in ("roads", "areas")} | {"roads": len(roads), "areas": len(areas)}, ensure_ascii=False))


def proj(H, pts):
    return cv2.perspectiveTransform(np.asarray(pts, float).reshape(-1, 1, 2), H).reshape(-1, 2)


def dense(g, step=4.0):
    out = [g[0]]
    for a, b in zip(g[:-1], g[1:]):
        n = max(1, int(np.linalg.norm(b - a) / step))
        out += [a + (b - a) * k / n for k in range(1, n + 1)]
    return np.array(out)


def proj_front(H, pts, W_, H_):
    """Like proj, but points on the far side of the camera (behind it, beyond the horizon) become NaN, so they never
    come back flipped into the sky; in_frame_runs drops them. Which sign of w is "in front" depends on the scale H
    happens to have: it is the sign the bottom middle of the frame (surely ground) has."""
    m = np.linalg.inv(H) @ np.array([W_ / 2, 0.92 * H_, 1.0])
    front = np.sign(m[2]) or 1.0
    p = np.c_[np.asarray(pts, float), np.ones(len(pts))] @ H.T
    q = p[:, :2] / p[:, 2:3]
    q[p[:, 2] * front <= 1e-9] = np.nan
    return q


def in_frame_runs(q, W_, H_, margin):
    """Pieces of a projected line that stay within the frame + margin, and sane (not behind the camera)."""
    ok = (q[:, 0] > -margin) & (q[:, 0] < W_ + margin) & (q[:, 1] > -margin) & (q[:, 1] < H_ + margin)
    runs, cur = [], []
    for p, o in zip(q, ok):
        if o:
            cur.append(p)
        elif cur:
            runs.append(np.array(cur)); cur = []
    if cur:
        runs.append(np.array(cur))
    return [r for r in runs if len(r) > 1]


def road_lines(osm, g, name):
    """Map-metre polylines for a road name; a dual carriageway (two one-way ways) becomes its centre line."""
    ways = [e for e in osm["elements"] if e["type"] == "way" and e.get("tags", {}).get("highway") and e["tags"].get("name") == name]
    lines = [(dense(np.array([g.xy(p["lat"], p["lon"]) for p in e["geometry"]])), e["tags"].get("oneway") == "yes") for e in ways]
    ones = [l for l, o in lines if o]
    out = [l for l, o in lines if not o]
    if ones:
        ref = ones[0][-1] - ones[0][0]
        fwd = [l for l in ones if np.dot(l[-1] - l[0], ref) >= 0]
        back = np.vstack([l for l in ones if np.dot(l[-1] - l[0], ref) < 0]) if len(fwd) < len(ones) else None
        for l in fwd:
            if back is not None:
                nn = np.array([back[np.argmin(np.linalg.norm(back - p, axis=1))] for p in l])
                close = np.linalg.norm(nn - l, axis=1) < 40
                l = np.where(close[:, None], (l + nn) / 2, l)
            out.append(l)
    return out


def trusted(lines, trust):
    """Cut map lines down to the zone the fit can be trusted in (a circle in map metres)."""
    if not trust:
        return lines
    c, R = np.array(trust["center"]), trust["reach"]
    out = []
    for l in lines:
        ok = np.linalg.norm(l - c, axis=1) <= R
        run = []
        for p, o in zip(l, ok):
            if o:
                run.append(p)
            elif run:
                out.append(np.array(run)); run = []
        if run:
            out.append(np.array(run))
    return [l for l in out if len(l) > 1]


def visible(d, g, H, W_, H_, trust=None):
    osm = json.load(open(os.path.join(d, "osm.json")))
    names = sorted({e["tags"]["name"] for e in osm["elements"] if e["type"] == "way" and e.get("tags", {}).get("highway")
                    and e["tags"].get("name") and e["tags"]["highway"] not in ("footway", "path", "steps", "cycleway")})
    roads = []
    for n in names:
        polys, seen = [], 0.0
        for l in trusted(road_lines(osm, g, n), trust):
            for r in in_frame_runs(proj_front(H, l, W_, H_), W_, H_, 0):
                seen += float(np.sum(np.linalg.norm(np.diff(r, axis=0), axis=1)))
                polys.append((r / [W_, H_]).round(4).tolist())
        if seen > 0.12 * max(W_, H_):
            kind = next(e["tags"]["highway"] for e in osm["elements"] if e["type"] == "way" and e.get("tags", {}).get("name") == n and e["tags"].get("highway"))
            roads.append({"name": n, "kind": kind, "seen": round(seen), "preview": polys})
    roads.sort(key=lambda r: -r["seen"])
    areas = []
    for e in osm["elements"]:
        t = e.get("tags", {})
        if e["type"] != "way" or not t.get("name") or t.get("highway"):
            continue
        q = proj(H, [g.xy(p["lat"], p["lon"]) for p in e["geometry"]])
        # how much of the area is in the picture (clip the outline to the frame), not how many corners are
        seen = cv2.intersectConvexConvex(np.float32([[0, 0], [W_, 0], [W_, H_], [0, H_]]), cv2.convexHull(q.astype(np.float32)))[0]
        if seen > 0.01 * W_ * H_ and np.all(np.abs(q) < 6 * max(W_, H_)):
            areas.append({"name": t["name"], "kind": t.get("leisure") or t.get("place") or t.get("landuse") or t.get("amenity") or "building",
                          "points": (q / [W_, H_]).round(4).tolist()})
    return roads, areas


def label_quad(p, text, start, W_, H_, h=34, gap=12):
    seg = np.r_[0, np.cumsum(np.linalg.norm(np.diff(p, axis=0), axis=1))]
    L = 0.62 * len(text) * h
    if seg[-1] < L + 40:
        return None
    start = min(start, seg[-1] - L - 20)
    pos = lambda s: np.array([np.interp(s, seg, p[:, 0]), np.interp(s, seg, p[:, 1])])  # noqa: E731
    a, b = pos(start), pos(start + L)
    v = (b - a) / (np.linalg.norm(b - a) or 1)
    if v[0] < -0.1 or (abs(v[0]) <= 0.1 and v[1] > 0):
        a, b, v = b, a, -v
    up = np.array([v[1], -v[0]])
    BL, BR = a + up * gap, b + up * gap
    return [[round(x / W_, 4), round(y / H_, 4)] for x, y in (BL + up * h, BR + up * h, BR, BL)]


def stitch(pieces, gap):
    """OSM cuts a road at every junction and roundabout, so its pieces leave holes there: join two pieces when one ends
    near where the other starts and the road keeps its heading (so the two halves of a dual carriageway stay apart)."""
    def head(q, end):
        a, b = (q[-1], q[max(0, len(q) - 4)]) if end else (q[0], q[min(len(q) - 1, 3)])
        v = a - b
        return v / (np.linalg.norm(v) or 1)
    out = [np.asarray(q, float) for q in pieces if len(q) > 1]
    joined = True
    while joined:
        joined = False
        for i in range(len(out)):
            for j in range(len(out)):
                if i == j:
                    continue
                for a in (out[i], out[i][::-1]):
                    for b in (out[j], out[j][::-1]):
                        jump = b[0] - a[-1]
                        dist = np.linalg.norm(jump)
                        if dist < gap and float(head(a, True) @ -head(b, False)) > 0.5 and (dist < 1 or float(head(a, True) @ (jump / dist)) > 0.3):
                            out[i] = np.vstack([a, b])
                            del out[j]
                            joined = True
                            break
                    if joined:
                        break
                if joined:
                    break
            if joined:
                break
    return out


def thin(g, step=22):
    out = [g[0]]
    for p in g[1:]:
        if np.linalg.norm(p - out[-1]) >= step:
            out.append(p)
    return np.array(out + [g[-1]])


def cmd_build(name, plan):
    d = work(name)
    meta = json.load(open(os.path.join(d, "meta.json")))
    fit = json.load(open(os.path.join(d, "fit.json")))
    g = Geo(*meta["center"], *meta["tiles"])
    H = np.load(os.path.join(d, "map2img.npy"))
    W_, H_ = meta["w"], meta["h"]
    osm = json.load(open(os.path.join(d, "osm.json")))
    status(d, "build", msg="Dựng lớp đường và nhãn")
    trails, labels, k = [], [], 0
    for r in plan.get("roads", []):
        pieces = []
        for l in trusted(road_lines(osm, g, r["name"]), fit.get("trust")):
            pieces += in_frame_runs(proj_front(H, l, W_, H_), W_, H_, 0.25 * max(W_, H_))   # run on past the edges
        pieces = stitch(pieces, 0.12 * max(W_, H_))
        pieces.sort(key=lambda q: -len(q))
        for j, q in enumerate(pieces):
            q = thin(q)
            trails.append({"key": 0, "lanes": 1, "color": r.get("color", "gold"), "points": (q / [W_, H_]).round(4).tolist(), "in": round(0.4 + 0.12 * k, 2)})
            if j == 0 and r.get("label", True):
                # start the name a little way in from where the road enters the picture
                inside = np.where((q[:, 0] > 40) & (q[:, 0] < W_ - 40) & (q[:, 1] > 40) & (q[:, 1] < H_ - 40))[0]
                s0 = float(np.sum(np.linalg.norm(np.diff(q[: inside[0] + 1], axis=0), axis=1))) + 60 if len(inside) else 150
                qd = label_quad(q, (r.get("text") or r["name"]).upper(), s0, W_, H_)
                if qd:
                    labels.append({"kind": "road", "lines": [(r.get("text") or r["name"]).upper()], "key": 0, "quad": qd, "in": round(1.0 + 0.2 * k, 2)})
        k += 1
    areas = []
    for a in plan.get("areas", []):
        pts = a.get("points") or next((x["points"] for x in fit["areas"] if x["name"] == a.get("name")), None)
        if pts:
            areas.append({"points": pts, "key": 0, "label": a.get("label", a.get("name")), "lift": a.get("lift", 40), "in": a.get("in", 1.6),
                          "color": a.get("color", "gold")})
    ov = {"aspect": plan.get("aspect", "16:9"), "theme": plan.get("theme", "gold"), "crop": "follow", "labels": labels, "trails": trails,
          "areas": areas, "pins": [], "title": {"text": plan["title"], "in": 0.8} if plan.get("title") else None,
          "credit": "© OpenStreetMap contributors" if plan.get("roads") or any(a.get("name") for a in plan.get("areas", [])) else None}
    json.dump(ov, open(os.path.join(d, "overlay.json"), "w"), ensure_ascii=False, indent=1)
    pub = f"drone-{name}"
    subprocess.run([sys.executable, os.path.join(HERE, "tracked-prep.py"), d, meta["clip"], "--start", str(meta["start"]), "--dur", str(meta["dur"]),
                    "--name", pub], check=True, stdout=subprocess.DEVNULL)
    status(d, "render", msg="Render video")
    props = json.dumps({"src": f"{pub}/clip.mp4", "tracked": f"{pub}/tracked.json"})
    out = os.path.join(d, "video.mp4")
    r = subprocess.run(["npx", "remotion", "render", "src/index.ts", "TrackedShot", out, f"--props={props}", "--crf=18"], cwd=REMOTION,
                       capture_output=True, text=True)
    if r.returncode != 0:
        status(d, "error", msg=(r.stderr or r.stdout)[-600:])
        raise SystemExit(r.returncode)
    status(d, "done", video=os.path.relpath(out, REPO))
    print(os.path.relpath(out, REPO))


# ── map editor (MapShot): one document of layers the user edits in Map Studio ─────────────────────────────────
PALETTE = ["#ffb02e", "#3aa8ff", "#3dff6e", "#ff5a4f", "#46ffc4", "#c084ff", "#ffffff", "#ffe14d"]
STYLES = ["glow", "neon", "comet", "arrows", "dashes", "dots", "ribbon", "outline", "laser", "pulse", "double", "shimmer", "sparkle", "electric", "tube",
          "surface", "wall", "trails", "route", "particles", "gradient", "markings", "wave", "grid"]


def pub_dir(name):
    p = os.path.join(PUBLIC, f"map-{name}")
    os.makedirs(p, exist_ok=True)
    return p


def request_of(d):
    f = os.path.join(d, "request.json")
    return json.load(open(f)) if os.path.exists(f) else {}


def publish_clip(name, src):
    """Copy the clip the editor plays into public under a new name, so the browser never shows a stale one."""
    n = int(time.time())
    for old in glob.glob(os.path.join(pub_dir(name), "clip-*.mp4")):
        discard(old)
    dst = os.path.join(pub_dir(name), f"clip-{n}.mp4")
    shutil.copyfile(src, dst)
    return f"map-{name}/clip-{n}.mp4"


def publish_source(name, d, fresh=False):
    """The ungraded clip: the editor's before / after and the base when no LUT is baked. `fresh` (a new stretch) puts it
    under a new name, so the browser does not keep showing the old one."""
    if not fresh:
        dst = os.path.join(pub_dir(name), "source.mp4")
        if not os.path.exists(dst):
            shutil.copyfile(os.path.join(d, "track.mp4"), dst)
        return f"map-{name}/source.mp4"
    for old in glob.glob(os.path.join(pub_dir(name), "source*.mp4")):
        discard(old)
    n = int(time.time())
    shutil.copyfile(os.path.join(d, "track.mp4"), os.path.join(pub_dir(name), f"source-{n}.mp4"))
    return f"map-{name}/source-{n}.mp4"


def default_plan(fit, req):
    roads = [r for r in fit["roads"] if r["kind"] not in ("service", "residential", "track")][:3] or fit["roads"][:3]
    return {"roads": [{"name": r["name"], "style": "glow", "color": PALETTE[i], "nameStyle": "along"} for i, r in enumerate(roads)],
            "areas": [{"name": a["name"], "label": a["name"].upper()} for a in fit["areas"][:1]], "look": "gold", "title": None,
            "why": "Bản nháp tự động: các đường lớn nhất trong khung"}


def draft_frame(d, fit):
    """The first frame with every road numbered and every area lettered, for Claude to look at."""
    img = cv2.imread(os.path.join(d, "frame.jpg"))
    W_, H_ = img.shape[1], img.shape[0]
    for i, r in enumerate(fit["roads"]):
        c = [(46, 176, 255), (255, 168, 58), (110, 255, 61), (79, 90, 255), (196, 255, 70), (255, 132, 192)][i % 6]
        for p in r["preview"]:
            q = (np.array(p) * [W_, H_]).astype(np.int32)
            cv2.polylines(img, [q], False, c, 5, cv2.LINE_AA)
        p = max(r["preview"], key=len)
        x, y = (np.array(p[len(p) // 2]) * [W_, H_]).astype(int)
        cv2.circle(img, (int(x), int(y)), 22, (20, 20, 20), -1)
        cv2.putText(img, str(i + 1), (int(x) - 14, int(y) + 10), cv2.FONT_HERSHEY_SIMPLEX, 0.9, (255, 255, 255), 2, cv2.LINE_AA)
    for i, a in enumerate(fit["areas"]):
        q = (np.array(a["points"]) * [W_, H_]).astype(np.int32)
        cv2.polylines(img, [q], True, (255, 255, 255), 3, cv2.LINE_AA)
        x, y = np.clip(q.mean(0), 30, [W_ - 30, H_ - 30]).astype(int)
        cv2.putText(img, chr(65 + i), (int(x), int(y)), cv2.FONT_HERSHEY_SIMPLEX, 1.6, (255, 255, 255), 4, cv2.LINE_AA)
    out = os.path.join(d, "draft.jpg")
    cv2.imwrite(out, img, [cv2.IMWRITE_JPEG_QUALITY, 85])
    return out


def draft_prompt(img, fit, req):
    roads = "\n".join(f"{i + 1}. {r['name']} ({r['kind']}, dài {r['seen']} px trong khung)" for i, r in enumerate(fit["roads"]))
    areas = "\n".join(f"{chr(65 + i)}. {a['name']} ({a['kind']})" for i, a in enumerate(fit["areas"])) or "(không có)"
    return f"""Bạn chuẩn bị bản nháp lớp bản đồ trên một clip flycam. Xem ảnh {img}: khung hình đầu, mỗi đường OSM đánh số, mỗi khu vực đánh chữ.

Yêu cầu của người dùng: {req.get('request') or '(không ghi gì: tự chọn cho đẹp, rõ)'}

Đường thấy trong khung:
{roads}

Khu vực:
{areas}

Chọn đường, khu vực, màu, kiểu nét và tiêu đề sao cho đúng yêu cầu. Ít mà rõ: thường 1 đến 4 đường. Đường người dùng nhắc tới phải có.
Kiểu nét: glow (phát sáng), neon (neon chạy), comet (vẽ dần có đầu sáng), arrows (mũi tên chạy, hợp chỉ hướng đi), dashes (nét đứt chạy),
dots (chấm tròn), ribbon (ruy băng rộng, hợp làm nổi cả con đường), outline (viền đôi, kiểu bản đồ), laser (tia mảnh sáng rực),
pulse (sáng theo nhịp), double (hai vạch song song, hợp đại lộ), shimmer (ánh kim chạy, sang trọng, hợp bất động sản), sparkle (lấp lánh),
electric (tia điện), tube (ống nổi 3D). Đẹp nhất, nằm đúng phối cảnh mặt đất: surface (phủ màu lên đúng mặt đường, có vạch làn chạy),
wall (tường ánh sáng dựng dọc đường), trails (vệt đèn xe phơi sáng hai chiều, hợp cảnh đường phố), route (dải lộ trình có mũi tên, hợp chỉ đường), particles (hạt sáng chảy theo làn), gradient (dải chuyển hai màu),
markings (vạch kẻ đường phát sáng), wave (sóng sáng lan dọc đường), grid (lưới hologram, hợp chủ đề công nghệ).
Kiểu tên đường: along (chữ nằm dọc đường), pill (nhãn bo tròn), sign (biển tên đường), none.
Màu chọn trong: {', '.join(PALETTE)}. Look: gold (nắng ấm), mint (ánh xanh), clean (giữ nguyên màu).
Nhãn khu vực và tiêu đề viết hoa tiếng Việt có dấu, ngắn. Có thể thêm ghim (pin) ở vị trí x,y (phân số của khung) nếu yêu cầu nhắc một địa điểm không có trong danh sách.
Khi yêu cầu nói về tiện ích quanh đó (trường học, bệnh viện, chợ, siêu thị, quảng trường, công viên, trung tâm thương mại, biển…, kiểu video
bất động sản), dùng "callouts": huy hiệu đỏ viền vàng đặt đúng chỗ tiện ích, theo tên khu vực trong danh sách hoặc x,y. title 1 đến 3 chữ,
sub một ý ngắn có ích cho người mua (ví dụ "chỉ 2 phút đi bộ"), icon chọn trong: {', '.join(CALLOUT_ICONS)}. Một khu vực đã có callout
thì không cần thêm vào "areas". Tối đa 5 callout, không đặt hai cái sát nhau.

Chỉ trả về một JSON, không giải thích ngoài JSON:
{{"roads": [{{"name": "<tên đúng như danh sách>", "text": "<chữ hiện, mặc định là tên>", "style": "...", "color": "#...", "nameStyle": "..."}}],
 "areas": [{{"name": "<tên khu vực trong danh sách>", "label": "...", "color": "#..."}}], "pins": [{{"text": "...", "x": 0.5, "y": 0.5}}],
 "callouts": [{{"area": "<tên khu vực, hoặc bỏ trống và cho x, y>", "x": 0.5, "y": 0.5, "title": "...", "sub": "...", "icon": "..."}}],
 "look": "gold", "title": "<tiêu đề ngắn hoặc null>", "why": "<một câu: vì sao chọn vậy>"}}"""


# who writes the draft (the desktop app's settings): the Claude CLI on this machine, the Claude API or the Gemini API
# with the user's own key, or no one (the plain automatic draft)
AI = os.environ.get("MAP_AI", "claude-cli")
AI_NAME = {"claude-cli": "Claude", "anthropic": "Claude", "gemini": "Gemini"}.get(AI)


def ask_ai(d, fit, req):
    img = draft_frame(d, fit)
    model = os.environ.get("MAP_AI_MODEL")
    if AI == "claude-cli":
        r = subprocess.run(["claude", "-p", draft_prompt(img, fit, req), "--model", model or "sonnet", "--output-format", "json", "--max-turns", "4",
                            "--allowedTools", "Read"], capture_output=True, text=True, cwd=REPO, timeout=240, stdin=subprocess.DEVNULL)
        res = json.loads(r.stdout).get("result", "")
    elif AI == "anthropic":
        import anthropic
        import base64
        data = base64.standard_b64encode(open(img, "rb").read()).decode("utf-8")
        client = anthropic.Anthropic(timeout=240)   # the key: ANTHROPIC_API_KEY
        with client.messages.stream(model=model or "claude-sonnet-5-5", max_tokens=16000, messages=[{"role": "user", "content": [
                {"type": "image", "source": {"type": "base64", "media_type": "image/jpeg", "data": data}},
                {"type": "text", "text": draft_prompt("đính kèm", fit, req)}]}]) as stream:
            msg = stream.get_final_message()
        if msg.stop_reason == "refusal":
            raise RuntimeError("refusal")
        res = "".join(b.text for b in msg.content if b.type == "text")
    elif AI == "gemini":
        import base64
        import urllib.request
        data = base64.standard_b64encode(open(img, "rb").read()).decode("utf-8")
        body = {"contents": [{"parts": [{"inline_data": {"mime_type": "image/jpeg", "data": data}}, {"text": draft_prompt("đính kèm", fit, req)}]}],
                "generationConfig": {"responseMimeType": "application/json"}}
        rq = urllib.request.Request(f"https://generativelanguage.googleapis.com/v1beta/models/{model or 'gemini-flash-latest'}:generateContent",
                                    data=json.dumps(body).encode(), headers={"Content-Type": "application/json", "x-goog-api-key": os.environ["GEMINI_API_KEY"]})
        out = json.load(urllib.request.urlopen(rq, timeout=240))
        res = "".join(p.get("text", "") for p in out["candidates"][0]["content"]["parts"])
    else:
        return None
    return json.loads(res[res.index("{"): res.rindex("}") + 1])


def cmd_draft(name, ai=True):
    d = work(name)
    fit = json.load(open(os.path.join(d, "fit.json")))
    req = request_of(d)
    ai = ai and AI_NAME is not None
    status(d, "draft", msg=f"{AI_NAME} đang đọc yêu cầu và vẽ bản nháp" if ai else "Vẽ bản nháp tự động")
    plan, note = None, None
    if ai:
        try:
            plan = ask_ai(d, fit, req)
        except Exception as e:  # no AI, a wrong key, or an answer that is not JSON: fall back to the plain draft
            note = f"Không hỏi được {AI_NAME} ({type(e).__name__}), dùng bản nháp tự động"
    plan = plan or default_plan(fit, req)
    json.dump(plan, open(os.path.join(d, "plan.json"), "w"), ensure_ascii=False, indent=1)
    cmd_doc(name, plan)
    # in a longer job (start, points) the colour comes next: "ready" is said at the very end
    if not JOB or JOB["stages"][-1][0] == "draft":
        status(d, "ready", msg=note or plan.get("why"))


def cmd_doc(name, plan):
    """plan (roads by OSM name, areas by name or points) → map.json, the layers the editor and MapShot work on."""
    d = work(name)
    meta = json.load(open(os.path.join(d, "meta.json")))
    fit = json.load(open(os.path.join(d, "fit.json")))
    req = request_of(d)
    g = Geo(*meta["center"], *meta["tiles"])
    H = np.load(os.path.join(d, "map2img.npy"))
    W_, H_ = meta["w"], meta["h"]
    osm = json.load(open(os.path.join(d, "osm.json")))
    layers = []
    for k, r in enumerate(plan.get("roads", [])):
        pieces = []
        for l in trusted(road_lines(osm, g, r["name"]), fit.get("trust")):
            pieces += in_frame_runs(proj_front(H, l, W_, H_), W_, H_, 0.25 * max(W_, H_))   # run on past the edges
        pieces = stitch(pieces, 0.12 * max(W_, H_))
        pieces.sort(key=lambda q: -len(q))
        style = r.get("style") if r.get("style") in STYLES else "glow"
        for j, q in enumerate(pieces[:3]):
            if j and len(q) < 6:
                continue
            layers.append({"id": f"r{k}-{j}", "type": "road", "pts": (thin(q) / [W_, H_]).round(4).tolist(), "style": style,
                           "color": r.get("color") or PALETTE[k % len(PALETTE)], "width": 8, "speed": 1, "in": round(0.4 + 0.15 * k, 2),
                           **({"name": r.get("text") or r["name"], "nameStyle": r.get("nameStyle", "along")} if j == 0 else {"part": r.get("text") or r["name"]})})
    for k, a in enumerate(plan.get("areas", [])):
        pts = a.get("points") or next((x["points"] for x in fit["areas"] if x["name"] == a.get("name")), None)
        if pts:
            layers.append({"id": f"a{k}", "type": "area", "pts": pts, "label": a.get("label") or a.get("name"), "color": a.get("color", "#ffb02e"),
                           "in": round(1.2 + 0.2 * k, 2)})
    for k, c in enumerate(plan.get("callouts", []) or []):
        pts = next((x["points"] for x in fit["areas"] if x["name"] == c.get("area")), None)
        if pts:   # the middle of the part of the area that is in the picture
            q = np.clip(np.array(pts, float), 0.04, 0.96)
            pt = [round(float(q[:, 0].mean()), 4), round(float(q[:, 1].mean()), 4)]
        elif isinstance(c.get("x"), (int, float)) and isinstance(c.get("y"), (int, float)):
            pt = [c["x"], c["y"]]
        else:
            continue
        layers.append({"id": f"c{k}", "type": "callout", "pt": pt, "title": c.get("title") or c.get("area") or "Tiện ích", "sub": c.get("sub") or None,
                       "icon": c.get("icon") if c.get("icon") in CALLOUT_ICONS else "star", "in": round(1.0 + 0.35 * k, 2)})
    for k, p in enumerate(plan.get("pins", []) or []):
        if isinstance(p.get("x"), (int, float)) and isinstance(p.get("y"), (int, float)):
            layers.append({"id": f"p{k}", "type": "pin", "pt": [p["x"], p["y"]], "text": p.get("text", ""), "in": 1.4})
    # tall buildings the map knows go in as "real" ones: the ground layers pass behind them
    layers += osm_towers(meta, osm, H, W_, H_)
    old_f0 = os.path.join(d, "map.json")
    if os.path.exists(old_f0):   # buildings the user had SAM 2 follow are clicks on the clip, not map data: they stay
        layers += [l for l in json.load(open(old_f0)).get("layers", []) if l.get("type") == "seg"]
    tr = json.load(open(os.path.join(d, "track.json")))
    Hs = [sum(h, []) if isinstance(h[0], list) else h for h in tr["H"]]
    old_f = os.path.join(d, "map.json")
    old = json.load(open(old_f)) if os.path.exists(old_f) else {}
    source = old.get("source") or publish_source(name, d)
    # colour is the user's: a new draft keeps it (grade plays live in the browser, a LUT is baked into clip)
    doc = {"clip": old.get("clip") or source, "source": source, "grade": old.get("grade") or {"delog": "none"}, "baked": old.get("baked"),
           "clipW": W_, "clipH": H_, "srcW": tr["w"], "srcH": tr["h"], "fps": 30, "frames": len(Hs), "H": Hs,
           # framing the user set in the editor wins over the one asked for at the start
           "aspect": old.get("aspect") or req.get("aspect") or "16:9", "zoom": old.get("zoom"), "trim": old.get("trim"),
           "look": plan.get("look") or req.get("look") or "gold",
           "layers": layers, "title": plan.get("title") or None, "pan": old.get("pan"), "ground": physical_ground(H, W_, H_)[0].flatten().tolist(),
           "credit": "© OpenStreetMap contributors" if plan.get("roads") or plan.get("areas") else None}
    json.dump(doc, open(old_f, "w"), ensure_ascii=False)
    return doc


# the icons of src/mapshot/Callout.tsx (the badge Claude may put on amenities)
CALLOUT_ICONS = ["pin", "school", "hospital", "market", "mall", "park", "beach", "building", "car", "home", "shield", "leaf", "star"]


def cmd_recut(name, start, dur):
    """A new stretch of the clip for a doc already drawn on: cut and track it, then carry every layer, the map fit and
    the framing keys from the old first frame to the new one, through one track over both first frames."""
    d = work(name)
    meta = json.load(open(os.path.join(d, "meta.json")))
    doc_f = os.path.join(d, "map.json")
    clip, s0 = meta["clip"], meta["start"]
    W_, H_ = meta["w"], meta["h"]
    status(d, "cut", msg="Cắt đoạn mới từ clip gốc và bám chuyển động")
    T = np.eye(3)
    gap = abs(start - s0) >= 1 / 30
    if gap:
        a, b = min(s0, start), max(s0, start)
        # the stretch between the two first frames is tracked first: it says how the old first frame maps to the new one
        share = (b - a) / (b - a + dur)
        lt = cut_track(clip, a, b - a + 0.2, os.path.join(d, "link.mp4"), os.path.join(d, "link.json"), 0, share)
        Hl = [np.array(h, float).reshape(3, 3) for h in lt["H"]]
        i_old, i_new = min(len(Hl) - 1, round((s0 - a) * 30)), min(len(Hl) - 1, round((start - a) * 30))
        T = Hl[i_new] @ np.linalg.inv(Hl[i_old])   # old first frame → new first frame
        for f_ in ("link.mp4", "link.json"):
            os.remove(os.path.join(d, f_))
    tr = cut_track(clip, start, dur, os.path.join(d, "track.mp4"), os.path.join(d, "track.json"), share if gap else 0, 1)
    subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-i", os.path.join(d, "track.mp4"), "-frames:v", "1", "-q:v", "2", os.path.join(d, "frame.jpg")], check=True)
    status(d, "move", msg="Dời các lớp đã vẽ, phần khớp bản đồ và các điểm bố cục sang đoạn mới")
    meta.update({"start": start, "dur": dur, "clipDur": meta.get("clipDur") or clip_duration(clip), "track": track_quality(tr)})
    json.dump(meta, open(os.path.join(d, "meta.json"), "w"), ensure_ascii=False)
    # the map fit and everything drawn move with the first frame
    Hmap = T @ np.load(os.path.join(d, "map2img.npy"))
    np.save(os.path.join(d, "map2img.npy"), Hmap)
    fit_f = os.path.join(d, "fit.json")
    if os.path.exists(fit_f):
        fit = json.load(open(fit_f))
        fit["roads"], fit["areas"] = visible(d, Geo(*meta["center"], *meta["tiles"]), Hmap, W_, H_, fit.get("trust"))
        json.dump(fit, open(fit_f, "w"), ensure_ascii=False)
    doc = json.load(open(doc_f))
    # buildings followed by SAM 2 were followed frame by frame on the old stretch: they have to be clicked again
    doc["layers"] = [l for l in doc["layers"] if l.get("type") != "seg"]
    mv = lambda pts: (proj(T, np.array(pts, float) * [W_, H_]) / [W_, H_]).round(4).tolist()  # noqa: E731
    for l in doc["layers"]:
        if "pts" in l:
            l["pts"] = mv(l["pts"])
        if "pt" in l:
            l["pt"] = mv([l["pt"]])[0]
    shift, n = round((s0 - start) * 30), len(tr["H"])
    pan = [{"f": k["f"] + shift, "pt": mv([k["pt"]])[0]} for k in doc.get("pan") or [] if 0 <= k["f"] + shift < n]
    doc.update({"H": [sum(h, []) if isinstance(h[0], list) else h for h in tr["H"]], "frames": n, "trim": None, "pan": pan or None, "ground": physical_ground(Hmap, W_, H_)[0].flatten().tolist(),
                "source": publish_source(name, d, fresh=True)})
    if not doc.get("baked"):
        doc["clip"] = doc["source"]
    json.dump(doc, open(doc_f, "w"), ensure_ascii=False)
    b = doc.get("baked")
    if b:   # the colour baked into the old stretch: bake the new one the same way
        cmd_color(name, ["--delog", b["delog"], "--strength", str(b.get("strength", 1)), *(["--lut", b["lutPath"]] if b.get("lutPath") else [])])
    status(d, "ready", msg=f"Đã cắt lại đoạn {start:.1f}–{start + dur:.1f} giây, các lớp đã vẽ được giữ và dời theo")


def camera_from_pairs(mm, pi, W_, H_):
    """A real camera (lens angle, position, direction) through the user's point pairs (map metres ↔ frame pixels):
    the angle that leaves the smallest error, found by trying them all. Returns (map metres → pixels, mean error)."""
    obj = np.c_[np.asarray(mm, float), np.zeros(len(mm))]
    img = np.asarray(pi, float)
    best = None
    for fov in np.arange(15, 115, 0.5):
        f = (W_ / 2) / math.tan(math.radians(fov) / 2)
        K = np.array([[f, 0, W_ / 2], [0, f, H_ / 2], [0, 0, 1.0]])
        ok, rv, tv = cv2.solvePnP(obj, img, K, None, flags=cv2.SOLVEPNP_IPPE)
        if not ok:
            continue
        e = float(np.linalg.norm(cv2.projectPoints(obj, rv, tv, K, None)[0].reshape(-1, 2) - img, axis=1).mean())
        if best is None or e < best[0]:
            Rm = cv2.Rodrigues(rv)[0]
            G = K @ np.c_[Rm[:, 0], Rm[:, 1], tv.ravel()]
            best = (e, G / G[2, 2])
    return (best[1], best[0]) if best else (None, None)


def physical_ground(Hmap, W_, H_):
    """The ground homography of a real camera nearest to a fitted one. A fit from a few user points matches those
    points but need not be a camera at all, and 3D (buildings standing up) needs one: try lens angles, put the camera
    where it best explains the fit over the lower part of the frame (the ground), keep the best. Map metres → pixels."""
    img = np.array([[x, y] for x in np.linspace(0.08 * W_, 0.92 * W_, 7) for y in np.linspace(0.45 * H_, 0.97 * H_, 6)], float)
    mm = proj(np.linalg.inv(Hmap), img)
    obj = np.c_[mm, np.zeros(len(mm))]
    best = None
    for fov in np.arange(20, 112, 1.0):
        f = (W_ / 2) / math.tan(math.radians(fov) / 2)
        K = np.array([[f, 0, W_ / 2], [0, f, H_ / 2], [0, 0, 1.0]])
        ok, rv, tv = cv2.solvePnP(obj, img, K, None, flags=cv2.SOLVEPNP_IPPE)
        if not ok:
            continue
        e = float(np.linalg.norm(cv2.projectPoints(obj, rv, tv, K, None)[0].reshape(-1, 2) - img, axis=1).mean())
        if best is None or e < best[0]:
            Rm = cv2.Rodrigues(rv)[0]
            G = K @ np.c_[Rm[:, 0], Rm[:, 1], tv.ravel()]
            best = (e, G / G[2, 2])
    return (best[1], best[0]) if best else (Hmap, None)


def osm_towers(meta, osm, Hmap, W_, H_, min_h=20.0):
    """Tall buildings OpenStreetMap knows (a height, or a number of floors) whose footprint is in the picture: they
    become "real" building layers, so roads and areas drawn on the ground go behind them."""
    g = Geo(*meta["center"], *meta["tiles"])
    found = []
    for e in osm.get("elements", []):
        t = e.get("tags", {})
        if e.get("type") != "way" or not (t.get("building") or t.get("building:part")) or not e.get("geometry"):
            continue
        try:
            h = float(str(t.get("height", "")).replace("m", "").strip() or 0) or float(t.get("building:levels", 0)) * 3.3
        except ValueError:
            continue
        if h < min_h:
            continue
        mt = np.array([g.xy(p["lat"], p["lon"]) for p in e["geometry"]])
        if len(mt) > 3 and np.allclose(mt[0], mt[-1]):
            mt = mt[:-1]
        if len(mt) < 3:
            continue
        px = proj(Hmap, mt)
        if not ((px[:, 0] > -0.05 * W_) & (px[:, 0] < 1.05 * W_) & (px[:, 1] > 0) & (px[:, 1] < 1.1 * H_)).any():
            continue
        found.append({"name": t.get("name") or "", "pts": (px / [W_, H_]).round(4).tolist(), "height": round(h), "c": mt.mean(0)})
    # an outline and its parts describe the same tower: keep the tallest of those standing on one spot
    found.sort(key=lambda b: -b["height"])
    keep = []
    for b in found:
        if all(np.linalg.norm(b["c"] - k["c"]) > 6 for k in keep):
            keep.append(b)
    return [{"id": f"rb{i}", "type": "building", "real": True, "pts": b["pts"], "height": b["height"], "name": b["name"], "in": 0}
            for i, b in enumerate(keep[:12])]


def cmd_occluders(name):
    """Put the tall buildings from the map in a doc already drawn on (replacing the ones added this way before)."""
    d = work(name)
    status(d, "build", msg="Tìm các toà nhà cao có trong bản đồ")
    meta = json.load(open(os.path.join(d, "meta.json")))
    doc_f = os.path.join(d, "map.json")
    doc = json.load(open(doc_f))
    osm = json.load(open(os.path.join(d, "osm.json")))
    towers = osm_towers(meta, osm, np.load(os.path.join(d, "map2img.npy")), meta["w"], meta["h"])
    doc["layers"] = [l for l in doc["layers"] if not str(l.get("id", "")).startswith("rb")] + towers
    json.dump(doc, open(doc_f, "w"), ensure_ascii=False)
    names = ", ".join(b["name"] or "không tên" for b in towers[:4])
    status(d, "ready", msg=f"Đã thêm {len(towers)} toà nhà cao có sẵn" + (f": {names}" if towers else ". Bản đồ không có toà nào đủ cao ở đây, bạn có thể tự vẽ bằng công cụ Toà nhà."))


def cmd_refit(name, pairs):
    """New point pairs for a doc already drawn on: fit again, rebuild the layers that come from the map (Claude's plan:
    roads, areas, pins, callouts; tall buildings) and keep the ones the user drew by hand (they are in the frame already)."""
    d = work(name)
    old = json.load(open(os.path.join(d, "map.json")))
    cmd_fit(name, pairs)
    status(d, "build", msg="Đặt lại đường, vùng và toà nhà theo bản đồ mới")
    plan_f = os.path.join(d, "plan.json")
    doc = cmd_doc(name, json.load(open(plan_f)) if os.path.exists(plan_f) else {})
    doc["layers"] += [l for l in old["layers"] if str(l.get("id", "")).startswith("u")]   # (buildings from SAM 2 are kept by cmd_doc)
    json.dump(doc, open(os.path.join(d, "map.json"), "w"), ensure_ascii=False)
    fit = json.load(open(os.path.join(d, "fit.json")))
    status(d, "ready", msg=("Đã khớp lại bằng camera thật" if fit.get("camera") else "Đã khớp lại") + (f" (sai lệch {fit['pairError']:.0f} px)" if fit.get("pairError") is not None else "")
           + (f". {fit['warn']}" if fit.get("warn") else ""))


def cmd_segment(name, frame, points, label=None, highlight=True):
    """Follow the buildings the user clicked through the clip with SAM 2 (scripts/segment.py, in the .venv-ml
    environment; points [x, y, label, building]): their outlines on every frame go next to the clip in public, and a
    layer each goes in the doc. They hide the ground layers behind them; the first is highlighted when asked."""
    d = work(name)
    status(d, "seg", msg="SAM 2 đang lần theo toà nhà qua từng khung hình")
    py = os.environ.get("MAP_SAM_PYTHON") or os.path.join(REPO, ".venv-ml", "bin", "python")
    if not os.path.exists(py):
        raise RuntimeError("Chưa cài SAM 2 (.venv-ml)")
    sid = str(int(time.time()))
    tail = run_progress([py, os.path.join(HERE, "segment.py"), d, "--id", sid, "--frame", str(int(frame)), "--points", json.dumps(points),
                         "--out", pub_dir(name), "--progress"], lambda ln: float(ln.split()[1]) if ln.startswith("P ") else None)
    found = json.loads(next(ln for ln in reversed(tail) if ln.startswith("RESULT "))[7:])
    doc_f = os.path.join(d, "map.json")
    doc = json.load(open(doc_f))
    for k, r in enumerate(found):
        # the frames to look at stay with the work folder
        for tag in ("first", "mid", "last"):
            src = os.path.join(pub_dir(name), f"seg-{r['id']}-debug-{tag}.jpg")
            if os.path.exists(src):
                os.replace(src, os.path.join(d, f"seg-{r['id']}-debug-{tag}.jpg"))
        lit = highlight and k == 0
        doc["layers"].append({"id": f"s{r['id']}", "type": "seg", "src": f"map-{name}/seg-{r['id']}.json",
                              "name": (label if lit and label else ("Toà nhà" if lit else f"Toà che đường {k + 1 if not highlight else k}")),
                              "hl": {"fx": "glow", "color": "#ffd166", "label": label or None} if lit else None,
                              "occlude": True, "dim": False, "in": 0.6, "iouMin": r["iouMin"], "weak": r["weak"][:50]})
    json.dump(doc, open(doc_f, "w"), ensure_ascii=False)
    worst = min(r["iouMin"] for r in found)
    bad = sum(1 for r in found if r["weak"])
    status(d, "ready", msg=f"Đã tách {len(found)} toà nhà qua {found[0]['n']} khung hình, độ khớp giữa các khung thấp nhất {worst * 100:.0f}%"
           + (f", {bad} toà có khung cần xem lại" if bad else ""))


def needs_bake(delog, lut):
    """D-Log M goes through DJI's LUT and a user LUT is 3D: both are baked into the clip; the rest plays live."""
    return delog == "dlogm" or bool(lut)


def cmd_color(name, args, full=False):
    """--still: a before / after frame of delog + LUT. Otherwise bake delog + LUT into the clip when needed (from the
    1080p working copy, seconds; `full` = from the original, for the export), else go back to the ungraded clip."""
    d = work(name)
    doc_f = os.path.join(d, "map.json")
    doc = json.load(open(doc_f))
    opt_ = lambda k, dflt: args[args.index(k) + 1] if k in args else dflt  # noqa: E731
    still, lut, kind = "--still" in args, opt_("--lut", None), opt_("--delog", "none")
    bake = needs_bake(kind, lut)
    if still or bake:
        status(d, "color", msg="Xem thử màu" if still else ("Xuất màu chất lượng cao" if full else ("Delog D-Log M bằng LUT DJI" if kind == "dlogm" and not lut else "Áp LUT vào clip")))
        # the export bakes as big as the output needs (ratio and zoom), up to the 4K the editor can use
        sizes = {"16:9": (1920, 1080), "9:16": (1080, 1920), "1:1": (1080, 1080), "4:5": (1080, 1350)}
        OW, OH = sizes.get(doc.get("aspect"), (1920, 1080))
        k = max(OW / doc["srcW"], OH / doc["srcH"]) * max(1.0, doc.get("zoom") or 1)
        h = str(min(2160, int(doc["srcH"] * k + 1) // 2 * 2)) if full else "1080"
        run_progress([sys.executable, os.path.join(HERE, "mapcolor.py"), d, *args, "--height", h, *([] if full or still else ["--fast"])],
                     lambda ln: float(ln.split()[1]) if ln.startswith("P ") else None)
    if not still:
        doc = json.load(open(doc_f))  # edits may have landed while ffmpeg ran
        if bake:
            doc["clip"] = publish_clip(name, os.path.join(d, "graded.mp4"))
            doc["baked"] = {"delog": kind, "lut": os.path.basename(lut) if lut else None, "lutPath": lut, "strength": float(opt_("--strength", 1)),
                            "full": full}
        else:
            doc["clip"], doc["baked"] = doc.get("source") or publish_source(name, d), None
            for old in glob.glob(os.path.join(pub_dir(name), "clip-*.mp4")):
                discard(old)
        doc["grade"] = {**(doc.get("grade") or {}), "delog": kind}
        json.dump(doc, open(doc_f, "w"), ensure_ascii=False)
    status(d, "ready", msg="Đã tạo ảnh xem thử" if still else ("Đã chỉnh màu" if bake else "Đã bỏ LUT"))


def cmd_render(name):
    d = work(name)
    doc = json.load(open(os.path.join(d, "map.json")))
    b = doc.get("baked")
    if b and not b.get("full"):
        # the editor played a quick bake from the 8-bit working copy: the export bakes again from the original
        cmd_color(name, ["--delog", b["delog"], "--strength", str(b.get("strength", 1)), *(["--lut", b["lutPath"]] if b.get("lutPath") else [])], full=True)
        doc = json.load(open(os.path.join(d, "map.json")))
    status(d, "render", msg="Chuẩn bị dựng hình")
    # the render reads the document from public, next to the clip
    json.dump(doc, open(os.path.join(pub_dir(name), "map.json"), "w"), ensure_ascii=False)
    out = os.path.join(d, "video.mp4")

    def parse(line):   # Remotion: "Bundling 45%", "Rendered 12/150, time remaining: 9s", "Encoded 150/150"
        m = re.match(r"\s*Bundling (\d+)%", line)
        if m:
            return 0.08 * int(m.group(1)) / 100
        m = re.match(r"\s*(Rendered|Encoded) (\d+)/(\d+)(?:, time remaining: (.+))?", line)
        if m:
            f_, n_ = int(m.group(2)), max(1, int(m.group(3)))
            v = 0.08 + 0.87 * f_ / n_ if m.group(1) == "Rendered" else 0.95 + 0.05 * f_ / n_
            _LAST["kw"]["msg"] = (f"Dựng hình {f_}/{n_}" + (f", còn khoảng {m.group(4)}" if m.group(4) else "")) if m.group(1) == "Rendered" else "Mã hoá video"
            return v
        return None
    # the desktop app renders with its own prebuilt bundle (MAP_RENDER: the command, then the same arguments as the CLI)
    render = json.loads(os.environ["MAP_RENDER"]) if os.environ.get("MAP_RENDER") else ["npx", "remotion", "render", "src/map-index.ts"]
    run_progress([*render, "MapShot", out, "--props=" + json.dumps({"map": f"map-{name}/map.json"}), "--crf=18"],
                 parse, cwd=None if os.environ.get("MAP_RENDER") else REMOTION)
    video = os.path.relpath(out, ROOT).replace(os.sep, "/")
    status(d, "done", video=video, msg="Video đã sẵn sàng để tải về")
    print(video)


def cmd_start(clip, name, start, dur, center):
    """Everything up to a draft the user can edit: prep, map, fit from the flight data when there is any, Claude's draft,
    then the colour. Without GPS it stops for the place; without flight data, for the guided points."""
    cmd_prep(clip, name, start, dur, center)
    d = work(name)
    meta = json.load(open(os.path.join(d, "meta.json")))
    if not meta.get("tiles"):
        return
    if not meta.get("flight"):
        status(d, "need-points", msg="Chọn vài điểm để khớp bản đồ")
        return
    cmd_fit(name, None)
    cmd_draft(name)
    after_draft(name)


def after_draft(name):
    """The colour asked for at the start: delog (found automatically when asked) goes in the live grade, a LUT is baked."""
    d = work(name)
    status(d, "color", msg="Nhận biết màu của clip")
    c = request_of(d).get("color") or {}
    kind = c.get("delog", "auto")
    if kind == "auto":
        r = subprocess.run([sys.executable, os.path.join(HERE, "mapcolor.py"), d, "--delog", "auto", "--detect"], capture_output=True, text=True, check=True)
        kind = json.loads(r.stdout.strip().splitlines()[-1])["delog"]
    doc_f = os.path.join(d, "map.json")
    doc = json.load(open(doc_f))
    doc["grade"] = {**(doc.get("grade") or {}), "delog": kind}
    json.dump(doc, open(doc_f, "w"), ensure_ascii=False)
    lut = c["lut"] if c.get("lut") and os.path.exists(c["lut"]) else None
    if needs_bake(kind, lut):
        cmd_color(name, ["--delog", kind, "--strength", str(c.get("strength", 1)), *(["--lut", lut] if lut else [])])
    else:
        status(d, "ready", msg="Bản nháp đã sẵn sàng")


# the stages of a new clip, in order (later entry points start part way in)
STAGES = [("prep", "Cắt đoạn và bám chuyển động mặt đất"), ("place", "Tải ảnh vệ tinh và bản đồ đường phố"), ("fit", "Khớp bản đồ vào khung hình"),
          ("draft", f"{AI_NAME} đọc yêu cầu và vẽ bản nháp" if AI_NAME else "Vẽ bản nháp tự động"), ("color", "Chỉnh màu clip")]

if __name__ == "__main__":
    a = sys.argv[1:]
    opt = lambda k, dflt=None: a[a.index(k) + 1] if k in a else dflt  # noqa: E731
    try:
        if a[0] == "prep":
            c = opt("--center")
            cmd_prep(a[1], opt("--name"), float(opt("--start", 0)), float(opt("--dur", 8)), tuple(map(float, c.split(","))) if c else None)
        elif a[0] == "place":
            c = opt("--center")
            if not c:
                f = json.load(open(os.path.join(work(opt("--name")), "meta.json"))).get("flight")
                if not f:
                    raise SystemExit("Cần toạ độ nơi quay")
                c = f"{f['lat']},{f['lon']}"
            cmd_place(opt("--name"), tuple(map(float, c.split(","))))
        elif a[0] == "fit":
            p = opt("--pairs")
            cmd_fit(opt("--name"), json.loads(p) if p else None)
        elif a[0] == "build":
            cmd_build(opt("--name"), json.loads(opt("--plan")))
        elif a[0] == "start":
            job("Chuẩn bị clip", STAGES)
            c = opt("--center")
            cmd_start(a[1], opt("--name"), float(opt("--start", 0)), float(opt("--dur", 8)), tuple(map(float, c.split(","))) if c else None)
        elif a[0] == "points" and "--keep" in a:   # matched again on a doc already drawn on: redo the map layers only
            job("Khớp lại bản đồ", [("fit", "Khớp bản đồ vào khung hình"), ("build", "Đặt lại đường, vùng và toà nhà theo bản đồ mới")])
            cmd_refit(opt("--name"), json.loads(opt("--pairs")))
        elif a[0] == "points":   # guided points done: fit, draft, colour
            job("Khớp bản đồ và vẽ bản nháp", STAGES[2:])
            cmd_fit(opt("--name"), json.loads(opt("--pairs")))
            cmd_draft(opt("--name"))
            after_draft(opt("--name"))
        elif a[0] == "place-go":  # place given later: map, then on as start would
            job("Tải bản đồ và vẽ bản nháp", STAGES[1:])
            c = opt("--center")
            cmd_place(opt("--name"), tuple(map(float, c.split(","))))
            m = json.load(open(os.path.join(work(opt("--name")), "meta.json")))
            if m.get("flight"):
                cmd_fit(opt("--name"), None); cmd_draft(opt("--name")); after_draft(opt("--name"))
            else:
                status(work(opt("--name")), "need-points", msg="Chọn vài điểm để khớp bản đồ")
        elif a[0] == "draft":
            job(f"{AI_NAME or 'Máy'} đang vẽ lại", [("draft", f"{AI_NAME} đọc yêu cầu và vẽ các lớp" if AI_NAME else "Vẽ lại bản nháp tự động")])
            cmd_draft(opt("--name"), "--plain" not in a)
        elif a[0] == "color":
            job("Chỉnh màu clip", [("color", "Nướng màu vào clip")])
            cmd_color(opt("--name"), json.loads(opt("--args", "[]")))
        elif a[0] == "render":
            dm = json.load(open(os.path.join(work(opt("--name")), "map.json")))
            job("Xuất video", ([("color", "Nướng màu chất lượng cao từ file gốc")] if dm.get("baked") and not dm["baked"].get("full") else [])
                + [("render", "Dựng hình và mã hoá video")])
            cmd_render(opt("--name"))
        elif a[0] == "occluders":
            job("Tìm toà nhà cao có sẵn", [("build", "Đọc bản đồ và đặt các toà nhà cao")])
            cmd_occluders(opt("--name"))
        elif a[0] == "segment":
            job("Tách toà nhà bằng SAM 2", [("seg", "Lần theo toà nhà qua từng khung hình")])
            cmd_segment(opt("--name"), int(opt("--frame", 0)), json.loads(opt("--points")), opt("--label"), "--no-highlight" not in a)
        elif a[0] == "recut":
            dm = json.load(open(os.path.join(work(opt("--name")), "map.json")))
            job("Cắt lại đoạn video", [("cut", "Cắt đoạn mới và bám chuyển động"), ("move", "Dời các lớp đã vẽ sang đoạn mới")]
                + ([("color", "Nướng lại màu")] if dm.get("baked") else []))
            cmd_recut(opt("--name"), float(opt("--start")), float(opt("--dur")))
        else:
            raise SystemExit(__doc__)
    except SystemExit:
        raise
    except Exception as e:
        if opt("--name"):
            msg = str(e) if isinstance(e, RuntimeError) else f"{type(e).__name__}: {str(e)[-300:]}"
            st = json.load(open(os.path.join(work(opt("--name")), "status.json"))) if os.path.exists(os.path.join(work(opt("--name")), "status.json")) else {}
            status(work(opt("--name")), "error", msg=msg, at=st.get("step"))
        raise
