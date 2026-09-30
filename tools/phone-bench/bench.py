"""The Mi 9T / iPhone comparison bench.

    python bench.py calibrate           what the HARNESS costs on each phone, before any app number is believed
    python bench.py tabs [repeats]      bottom tabs: tap -> first visible change -> settled
    python bench.py scroll [repeats]    feed scroll: capture frame gaps, plus Android's own renderer stats
    python bench.py startup [repeats]   warm start (app backgrounded, then launched)
    python bench.py weight              what each phone stores for the app, and its memory

Results are one JSON object per line in RUNS/<scenario>.ndjson, screenshots in RUNS/shots/ - both
OUTSIDE the repo, in the rig's state dir: a screenshot of a campaign account is not for a public repo.
Nothing here touches the PIN or signs anything out; it only taps tabs, scrolls and launches.
"""

import json
import os
import statistics
import sys
import time

from phones import Android, IOS, frame_gaps_ms, settled_after

RUNS = os.environ.get("BENCH_RUNS", r"F:\Programmation\canari-harness\ios-bench\runs")
TABS = ["Feed", "Communaut", "Discussions", "Tableau de bord"]  # prefixes: the accent is encoding-fragile


def phones():
    return [Android(), IOS()]


def record(scenario, row):
    os.makedirs(RUNS, exist_ok=True)
    row = {"scenario": scenario, "ts": time.strftime("%Y-%m-%dT%H:%M:%S"), **row}
    with open(os.path.join(RUNS, scenario + ".ndjson"), "a", encoding="utf-8") as f:
        f.write(json.dumps(row, ensure_ascii=False) + "\n")
    return row


def shot(p, label):
    d = os.path.join(RUNS, "shots")
    os.makedirs(d, exist_ok=True)
    return p.screenshot(os.path.join(d, f"{p.name.replace(' ', '')}-{label}.png"))


# The iPhone's floating tab bar exposes its four icons with NO label (only a badge count), so its
# tabs are tapped by position, read off a screenshot. Android's carry their text and are looked up.
IOS_TABS = {"Feed": (0.18, 0.94), "Communaut": (0.39, 0.94), "Discussions": (0.60, 0.94), "Tableau de bord": (0.81, 0.94)}


def find_tab(p, prefix):
    if isinstance(p, IOS):
        fx, fy = IOS_TABS[prefix]
        return {"fx": fx, "fy": fy}
    for e in p.tree():
        if e["fy"] > 0.85 and e["text"].startswith(prefix):
            return e
    raise RuntimeError(f"{p.name}: no tab starting with {prefix!r}")


def timed_action(p, action, window=1.6):
    """Runs `action` while capturing; returns (first_change_ms, settled_ms, dispatch_ms, capture)."""
    cap = p.start_capture()
    time.sleep(1.2)  # frames flowing, screen still
    ref = p.reference() if isinstance(p, Android) and not cap.frames else None
    t0 = time.perf_counter()
    action()
    dispatch = time.perf_counter() - t0
    time.sleep(window)
    frames = cap.stop()
    first, settled = settled_after(frames, t0, baseline=ref)
    ms = lambda v: None if v is None else round(v * 1000)
    return ms(first), ms(settled), round(dispatch * 1000), frames, t0


def med(xs):
    xs = [x for x in xs if x is not None]
    return round(statistics.median(xs)) if xs else None


def calibrate():
    """Two baselines. (1) dispatch: how long the harness call itself takes to return, on a tap that
    lands on nothing (the status-bar strip). (2) the capture's own frame cadence on a still screen
    and during a swipe. An app latency smaller than these is not a measurement."""
    for p in phones():
        p.launch()
        time.sleep(2)
        d = []
        for _ in range(8):
            t = time.perf_counter()
            p.tap(0.5, 0.01)
            d.append((time.perf_counter() - t) * 1000)
        first, settled, dispatch, frames, t0 = timed_action(p, lambda: p.swipe(0.5, 0.7, 0.5, 0.4, 0.3))
        gaps = frame_gaps_ms(frames, t0, t0 + 1.5)
        print(p.name, "dispatch tap ms median", round(statistics.median(d)), "min", round(min(d)),
              "| swipe: first change", first, "ms, frames", len(gaps) + 1,
              "gap median", round(statistics.median(gaps)) if gaps else None)
        record("calibrate", {"phone": p.name, "tap_dispatch_ms_median": round(statistics.median(d)),
                             "tap_dispatch_ms_min": round(min(d)), "swipe_dispatch_ms": dispatch,
                             "capture_gap_ms_median": round(statistics.median(gaps)) if gaps else None})


def tabs(repeats=3):
    for p in phones():
        p.launch()
        time.sleep(2)
        pos = {t: find_tab(p, t) for t in TABS}
        for t in TABS:
            res = []
            for i in range(repeats):
                other = TABS[0] if t != TABS[0] else TABS[1]
                p.tap(pos[other]["fx"], pos[other]["fy"])
                time.sleep(1.5)
                first, settled, dispatch, _, _ = timed_action(p, lambda: p.tap(pos[t]["fx"], pos[t]["fy"]))
                res.append((first, settled, dispatch))
                record("tabs", {"phone": p.name, "tab": t, "run": i, "first_ms": first, "settled_ms": settled, "dispatch_ms": dispatch})
            shot(p, "tab-" + t.replace(" ", "_"))
            print(p.name, t, "first", med([r[0] for r in res]), "settled", med([r[1] for r in res]),
                  "dispatch", med([r[2] for r in res]))
        p.tap(pos[TABS[0]]["fx"], pos[TABS[0]]["fy"])


def scroll(repeats=3):
    for p in phones():
        p.launch()
        time.sleep(2)
        pos = find_tab(p, TABS[0])
        p.tap(pos["fx"], pos["fy"])
        time.sleep(1.5)
        for i in range(repeats):
            if isinstance(p, Android):
                p.gfx_reset()
            first, settled, dispatch, frames, t0 = timed_action(p, lambda: p.swipe(0.5, 0.75, 0.5, 0.25, 0.35), window=1.5)
            gaps = frame_gaps_ms(frames, t0, t0 + 1.4)
            row = {"phone": p.name, "run": i, "first_ms": first, "settled_ms": settled, "dispatch_ms": dispatch,
                   "frames": len(gaps) + 1, "gap_median_ms": round(statistics.median(gaps)) if gaps else None,
                   "gap_max_ms": round(max(gaps)) if gaps else None}
            if isinstance(p, Android):
                row["gfx"] = p.gfx()
            record("scroll", row)
            print(p.name, row)
            p.swipe(0.5, 0.25, 0.5, 0.75, 0.25)
            time.sleep(1)
        shot(p, "feed-scrolled")


def startup(repeats=3):
    for p in phones():
        for i in range(repeats):
            p.launch()
            time.sleep(2)
            p.adb("shell", "input", "keyevent", "KEYCODE_HOME") if isinstance(p, Android) else p._call(
                "POST", f"/session/{p.sid}/wda/pressButton", {"name": "home"})
            time.sleep(1.5)
            first, settled, dispatch, _, _ = timed_action(p, lambda: p.launch(), window=3.5)
            record("startup", {"phone": p.name, "kind": "warm", "run": i, "first_ms": first, "settled_ms": settled, "dispatch_ms": dispatch})
            print(p.name, "warm start", i, "first", first, "settled", settled, "launch call", dispatch)
        shot(p, "after-startup")


def weight():
    a, i = Android(), IOS()
    w = a.weight()
    print("Android APK files (bytes):", w, "total MB", round(sum(w.values()) / 1e6, 1))
    print("Android PSS KB:", a.memory_kb())
    record("weight", {"phone": a.name, "apk_bytes": w, "pss_kb": a.memory_kb()})


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    arg = int(sys.argv[2]) if len(sys.argv) > 2 else None
    fn = {"calibrate": calibrate, "tabs": tabs, "scroll": scroll, "startup": startup, "weight": weight}.get(cmd)
    if not fn:
        sys.exit(__doc__)
    fn(arg) if arg and cmd != "calibrate" and cmd != "weight" else fn()
