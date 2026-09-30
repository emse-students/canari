"""One interface over the two bench phones, so a scenario is written once and run on both.

    Android (Mi 9T)  adb for input and tree, `screenrecord` H.264 decoded frame by frame for the
                     screen, `dumpsys gfxinfo` for the renderer's own frame times
    iPhone 12        WebDriverAgent over HTTP (`tools/ios-device/wda-daemon.py` keeps it alive on
                     127.0.0.1:8100 and forwards the MJPEG stream on :9100) for input, tree and screen

Every coordinate a scenario passes is a FRACTION of the screen (0..1). Points on the iPhone and
pixels on the Android differ by a factor nobody wants to carry around.

The clocks: a capture stamps each frame with the host's `perf_counter` the moment it ARRIVES, so a
measured latency is action dispatched -> frame arrived on the host. It includes the harness's own
pipeline, which differs per phone and is measured by `bench.py calibrate`, never assumed.
"""

import io
import json
import os
import queue
import re
import socket
import subprocess
import threading
import time
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET

import numpy as np

ADB = os.environ.get("ADB", "adb")
THUMB = 8  # Android frames are kept every 8th pixel in both axes: enough for change detection
_ENV = dict(os.environ, MSYS_NO_PATHCONV="1")


class Capture:
    """Frames of one phone's screen, each stamped with the host clock at arrival."""

    def __init__(self):
        self.frames = []  # [(t, small grayscale ndarray)]
        self._stop = False
        self._thread = None

    def stop(self):
        self._stop = True
        if self._thread:
            self._thread.join(timeout=3)
        return self.frames


class Phone:
    name = "?"
    app = ""

    def sleep_settle(self, seconds=0.4):
        time.sleep(seconds)


class Android(Phone):
    name = "Mi 9T"
    app = "fr.emse.canari"

    def __init__(self):
        out = self.adb("shell", "wm", "size").decode()
        w, h = map(int, re.search(r"(\d+)x(\d+)", out).groups())
        self.w, self.h = w, h

    @staticmethod
    def adb(*args, check=True):
        return subprocess.run([ADB, *args], capture_output=True, env=_ENV, check=check).stdout

    def xy(self, fx, fy):
        return int(fx * self.w), int(fy * self.h)

    def tap(self, fx, fy):
        x, y = self.xy(fx, fy)
        self.adb("shell", "input", "tap", str(x), str(y))

    def swipe(self, fx1, fy1, fx2, fy2, seconds=0.3):
        x1, y1 = self.xy(fx1, fy1)
        x2, y2 = self.xy(fx2, fy2)
        self.adb("shell", "input", "swipe", str(x1), str(y1), str(x2), str(y2), str(int(seconds * 1000)))

    def back(self):
        self.adb("shell", "input", "keyevent", "KEYCODE_BACK")

    def screenshot(self, path):
        data = self.adb("exec-out", "screencap", "-p")
        with open(path, "wb") as f:
            f.write(data)
        return path

    def tree(self):
        """Visible texts with their centre as a fraction of the screen. Costs ~2.5 s: never inside a timing."""
        self.adb("shell", "uiautomator", "dump", "/sdcard/bench.xml")
        xml = self.adb("exec-out", "cat", "/sdcard/bench.xml").decode("utf-8", "replace")
        out = []
        for n in ET.fromstring(xml).iter("node"):
            text = n.get("text") or n.get("content-desc") or ""
            m = re.match(r"\[(\d+),(\d+)\]\[(\d+),(\d+)\]", n.get("bounds") or "")
            if text and m:
                x1, y1, x2, y2 = map(int, m.groups())
                out.append({"text": text, "fx": (x1 + x2) / 2 / self.w, "fy": (y1 + y2) / 2 / self.h, "type": n.get("class")})
        return out

    def nodes(self):
        """Every node of the UI dump, in DP, for the layout audit: text, class, clickable, rect."""
        if not hasattr(self, "dp"):
            self.dp = int(re.search(r"(\d+)", self.adb("shell", "wm", "density").decode().split(":")[-1]).group(1)) / 160
        self.adb("shell", "uiautomator", "dump", "/sdcard/bench.xml")
        xml = self.adb("exec-out", "cat", "/sdcard/bench.xml").decode("utf-8", "replace")
        out = []
        for n in ET.fromstring(xml).iter("node"):
            m = re.match(r"\[(\d+),(\d+)\]\[(\d+),(\d+)\]", n.get("bounds") or "")
            if not m:
                continue
            x1, y1, x2, y2 = (int(v) / self.dp for v in m.groups())
            out.append({"text": n.get("text") or n.get("content-desc") or "", "type": n.get("class").split(".")[-1],
                        "click": n.get("clickable") == "true", "x1": x1, "y1": y1, "x2": x2, "y2": y2,
                        "W": self.w / self.dp, "H": self.h / self.dp})
        return out

    def launch(self, cold=False):
        if cold:
            self.adb("shell", "am", "force-stop", self.app)
            time.sleep(0.5)
        self.adb("shell", "monkey", "-p", self.app, "-c", "android.intent.category.LAUNCHER", "1")

    def stop_app(self):
        self.adb("shell", "am", "force-stop", self.app)

    def reference(self):
        """A baseline frame for a STILL screen: screenrecord sends nothing while nothing moves, so a
        capture started on a static page holds zero frames and has nothing to compare against. The
        PNG is thumbnailed the way the stream's frames are, so the two compare."""
        from PIL import Image

        png = self.adb("exec-out", "screencap", "-p")
        img = Image.open(io.BytesIO(png)).convert("L").resize((540, 1170))
        return np.asarray(img)[::THUMB, ::THUMB].copy()

    def keyboard_up(self):
        return b"mInputShown=true" in self.adb("shell", "dumpsys", "input_method")

    def hide_keyboard(self):
        self.back()

    def gfx_reset(self):
        self.adb("shell", "dumpsys", "gfxinfo", self.app, "reset")

    def gfx(self):
        """The renderer's own numbers since the last reset: frames, janky frames and percentiles in ms."""
        txt = self.adb("shell", "dumpsys", "gfxinfo", self.app).decode("utf-8", "replace")

        def grab(pattern, cast=float):
            m = re.search(pattern, txt)
            return cast(m.group(1)) if m else None

        return {
            "frames": grab(r"Total frames rendered: (\d+)", int),
            "janky": grab(r"Janky frames: (\d+)", int),
            "p50": grab(r"50th percentile: (\d+)ms"),
            "p90": grab(r"90th percentile: (\d+)ms"),
            "p95": grab(r"95th percentile: (\d+)ms"),
            "p99": grab(r"99th percentile: (\d+)ms"),
        }

    def memory_kb(self):
        txt = self.adb("shell", "dumpsys", "meminfo", self.app).decode("utf-8", "replace")
        m = re.search(r"TOTAL PSS:\s+(\d+)", txt) or re.search(r"TOTAL\s+(\d+)", txt)
        return int(m.group(1)) if m else None

    def start_capture(self):
        import av  # imported here so the iPhone half works without it

        cap = Capture()
        proc = subprocess.Popen(
            [ADB, "exec-out", "screenrecord", "--output-format=h264", "--size", "540x1170", "--bit-rate", "8000000", "-"],
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, env=_ENV,
        )

        chunks = queue.Queue()

        def pump():
            while not cap._stop:
                data = proc.stdout.read1(65536)
                if not data:
                    break
                chunks.put((time.perf_counter(), data))

        def run():
            # No ffmpeg probing: screenrecord sends nothing while the screen is still, and the demuxer
            # waits for enough frames to "estimate the rate" for ever. A bare parser+decoder does not.
            # The parser also holds the LAST frame until the next start code arrives, which on a screen
            # that has just stopped moving is never: so after 40 ms of silence an access-unit delimiter
            # is fed to release it. The frame keeps the arrival time of the bytes that completed it.
            codec = av.CodecContext.create("h264", "r")
            aud = b"\x00\x00\x00\x01\x09\xf0"
            last_t, pending = time.perf_counter(), False
            while not cap._stop:
                try:
                    last_t, data = chunks.get(timeout=0.04)
                    pending = True
                except queue.Empty:
                    if not pending:
                        continue
                    data, pending = aud, False
                for pkt in codec.parse(data):
                    for f in codec.decode(pkt):
                        cap.frames.append((last_t, f.to_ndarray(format="gray")[::THUMB, ::THUMB].copy()))

        threading.Thread(target=pump, daemon=True).start()

        cap._thread = threading.Thread(target=run, daemon=True)
        cap._thread.start()
        orig_stop = cap.stop

        def stop():
            frames = orig_stop()
            proc.kill()
            return frames

        cap.stop = stop
        return cap

    def weight(self):
        out = self.adb("shell", "pm", "path", self.app).decode()
        sizes = {}
        for line in out.splitlines():
            p = line.replace("package:", "").strip()
            sizes[os.path.basename(p)] = int(self.adb("shell", "stat", "-c", "%s", p).decode().strip())
        return sizes


class IOS(Phone):
    name = "iPhone 12"
    app = "fr.emse.canari"

    def __init__(self, wda="http://127.0.0.1:8100", mjpeg=("127.0.0.1", 9100)):
        self.base = wda
        self.mjpeg = mjpeg
        self.sid = self._call("GET", "/status").get("sessionId")
        size = None
        if self.sid:
            try:
                size = self._call("GET", f"/session/{self.sid}/window/size")["value"]
            except urllib.error.HTTPError:
                # /status keeps reporting the id of a session that died with the app (a reinstall, a
                # crash): a stale id answers 404 on every call, so it is replaced, not retried.
                self.sid = None
        if not self.sid:
            caps = {"bundleId": self.app}
            r = self._call("POST", "/session", {"capabilities": {"alwaysMatch": caps}, "desiredCapabilities": caps})
            self.sid = r.get("sessionId") or r["value"]["sessionId"]
            size = self._call("GET", f"/session/{self.sid}/window/size")["value"]
        self.w, self.h = size["width"], size["height"]  # points
        self._call("POST", f"/session/{self.sid}/appium/settings",
                   {"settings": {"mjpegServerFramerate": 60, "mjpegServerScreenshotQuality": 25, "mjpegScalingFactor": 25}})

    def _call(self, method, path, body=None):
        req = urllib.request.Request(self.base + path, method=method,
                                     data=None if body is None else json.dumps(body).encode(),
                                     headers={"Content-Type": "application/json"})
        return json.loads(urllib.request.urlopen(req, timeout=60).read())

    def xy(self, fx, fy):
        return int(fx * self.w), int(fy * self.h)

    def tap(self, fx, fy):
        x, y = self.xy(fx, fy)
        self._call("POST", f"/session/{self.sid}/actions", {"actions": [{
            "type": "pointer", "id": "f", "parameters": {"pointerType": "touch"},
            "actions": [{"type": "pointerMove", "duration": 0, "x": x, "y": y}, {"type": "pointerDown", "button": 0},
                        {"type": "pause", "duration": 30}, {"type": "pointerUp", "button": 0}]}]})

    def swipe(self, fx1, fy1, fx2, fy2, seconds=0.3):
        x1, y1 = self.xy(fx1, fy1)
        x2, y2 = self.xy(fx2, fy2)
        self._call("POST", f"/session/{self.sid}/wda/dragfromtoforduration",
                   {"fromX": x1, "fromY": y1, "toX": x2, "toY": y2, "duration": seconds})

    def back(self):
        # iOS has no back key: the app's own back control, or an edge swipe.
        self.swipe(0.0, 0.5, 0.6, 0.5, 0.25)

    def screenshot(self, path):
        import base64
        with open(path, "wb") as f:
            f.write(base64.b64decode(self._call("GET", f"/session/{self.sid}/screenshot")["value"]))
        return path

    def tree(self):
        def walk(n, out):
            text = " | ".join(dict.fromkeys(s for s in (n.get("label"), n.get("name"), n.get("value")) if isinstance(s, str) and s))
            r = n.get("rect")
            if text and r and n.get("isVisible") != "0":
                out.append({"text": text, "fx": (r["x"] + r["width"] / 2) / self.w,
                            "fy": (r["y"] + r["height"] / 2) / self.h, "type": n.get("type", "").replace("XCUIElementType", "")})
            for c in n.get("children") or []:
                walk(c, out)
            return out

        return walk(self._call("GET", f"/session/{self.sid}/source?format=json")["value"], [])

    def nodes(self):
        """Every node of the accessibility tree, in points, for the layout audit."""
        def walk(n, out):
            r = n.get("rect")
            kind = n.get("type", "").replace("XCUIElementType", "")
            if r:
                text = " | ".join(dict.fromkeys(s for s in (n.get("label"), n.get("name"), n.get("value")) if isinstance(s, str) and s))
                out.append({"text": text, "type": kind,
                            "click": n.get("isEnabled") != "0" and kind in ("Button", "Link", "Switch", "Cell", "TextField", "SecureTextField", "Tab"),
                            "x1": r["x"], "y1": r["y"], "x2": r["x"] + r["width"], "y2": r["y"] + r["height"],
                            "W": self.w, "H": self.h, "visible": n.get("isVisible") != "0"})
            for c in n.get("children") or []:
                walk(c, out)
            return out

        return walk(self._call("GET", f"/session/{self.sid}/source?format=json")["value"], [])

    def keyboard_up(self):
        return any(n["type"] == "Keyboard" for n in self.nodes())

    def hide_keyboard(self):
        """Closes the keyboard. A build that still draws the accessory bar has an OK button on it and
        that is tapped; a build without the bar (the app removes it since lot 4) has none, so WDA's
        own dismissal is asked instead."""
        for n in self.nodes():
            if n["type"] == "Button" and n["text"] == "OK" and 0.4 < (n["y1"] + n["y2"]) / 2 / n["H"] < 0.75:
                self.tap((n["x1"] + n["x2"]) / 2 / n["W"], (n["y1"] + n["y2"]) / 2 / n["H"])
                return
        self._call("POST", f"/session/{self.sid}/wda/keyboard/dismiss", {})

    def launch(self, cold=False):
        if cold:
            self.stop_app()
            time.sleep(0.5)
        self._call("POST", f"/session/{self.sid}/wda/apps/launch", {"bundleId": self.app})

    def stop_app(self):
        self._call("POST", f"/session/{self.sid}/wda/apps/terminate", {"bundleId": self.app})

    def start_capture(self):
        cap = Capture()
        from PIL import Image

        def run():
            s = socket.create_connection(self.mjpeg)
            s.settimeout(2)
            s.sendall(b"GET / HTTP/1.1\r\nHost: x\r\n\r\n")
            buf = b""
            while not cap._stop:
                try:
                    d = s.recv(65536)
                except socket.timeout:
                    continue
                if not d:
                    break
                buf += d
                while True:
                    a = buf.find(b"\xff\xd8")
                    b = buf.find(b"\xff\xd9", a + 2) if a >= 0 else -1
                    if a < 0 or b < 0:
                        break
                    jpg, buf = buf[a:b + 2], buf[b + 2:]
                    t = time.perf_counter()
                    img = Image.open(io.BytesIO(jpg)).convert("L").resize((68, 146))
                    cap.frames.append((t, np.asarray(img).copy()))
            s.close()

        cap._thread = threading.Thread(target=run, daemon=True)
        cap._thread.start()
        return cap


def unlock_app(p):
    """Types the bench account's PIN on the in-app keypad when the app is showing it, then taps
    "Deverrouiller". Returns True when the keypad was there. The PIN travels from a Bun child to
    this process's memory and nowhere else; the "keep me signed in" box is left as it is."""
    for attempt in range(2):
        digits = {e["text"]: e for e in p.tree() if e["text"] in set("0123456789") and 0.25 < e["fy"] < 0.85}
        if len(digits) >= 10:
            break
        if attempt == 0 and any(e["text"].startswith("D\u00e9verrouiller") for e in p.tree()):
            p.swipe(0.5, 0.35, 0.5, 0.8, 0.3)  # the sheet can be scrolled with the first digits off screen
            time.sleep(0.6)
    else:
        return False
    here = os.path.dirname(os.path.abspath(__file__))
    pin = subprocess.run(["bun", os.path.join(here, "pin.mjs")], capture_output=True, text=True, check=True).stdout.strip()
    for d in pin:
        p.tap(digits[d]["fx"], digits[d]["fy"])
        time.sleep(0.35)
    time.sleep(0.4)
    button = next((e for e in p.tree() if e["text"].startswith("Déverrouiller") and e["type"].endswith("Button")), None)
    if button is None:
        raise RuntimeError(f"{p.name}: no unlock button after the PIN")
    p.tap(button["fx"], button["fy"])
    time.sleep(3)
    return True


def settled_after(frames, t0, quiet=0.25, thr=0.003, baseline=None):
    """(first_change, settled) in seconds after t0: the first frame that differs from the one before
    t0, and the start of the first `quiet` seconds with no frame differing from its predecessor by
    more than `thr` (mean grey level). None when nothing moved. Frames of different phones are
    different sizes, so each capture is compared only with itself."""
    before = [f for f in frames if f[0] < t0]
    after = [f for f in frames if f[0] >= t0]
    if not before or not after:
        return None, None
    prev = before[-1][1].astype(np.int16)
    first = None
    last = None
    for t, img in after:
        d = float(np.mean(np.abs(img.astype(np.int16) - prev) > 10))  # share of pixels that changed visibly
        prev = img.astype(np.int16)
        if d > thr:
            if first is None:
                first = t - t0
            last = t - t0
    return first, (last if last is not None else None)


def frame_gaps_ms(frames, t0, t1):
    ts = [f[0] for f in frames if t0 <= f[0] <= t1]
    return list(np.diff(ts) * 1000) if len(ts) > 1 else []
