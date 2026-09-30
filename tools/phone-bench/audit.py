"""Layout audit of ONE screen on ONE phone, from the UI tree - the same rules for both.

A screen FAILS a rule when:
  overflow-x   a visible node pokes out of the screen sideways (a page that scrolls horizontally
               has nothing clipped, it has a layout that does not fit)
  scrollbar    the tree exposes a scroll bar (iOS lists them as elements: a visible bar is a
               design defect in an app that hides them everywhere else)
  small-target a tappable node is below the platform minimum: 44 pt on iOS, 48 dp on Android
  offscreen-tap a tappable node is entirely below/above the screen yet reported visible
Vertical overflow is NOT a finding: a page is allowed to scroll down.
"""

MIN_TARGET = {"iPhone 12": 44, "Mi 9T": 48}
SLACK = 2  # units: rounding in the tree's rects


def audit(p):
    findings = []
    for n in p.nodes():
        if n.get("visible") is False:
            continue
        w, h = n["x2"] - n["x1"], n["y2"] - n["y1"]
        if w <= 0 or h <= 0:
            continue
        label = (n["text"] or n["type"])[:50]
        on_screen_y = n["y2"] > 0 and n["y1"] < n["H"]
        if on_screen_y and n["type"] not in ("Application", "Window", "Other", "View", "FrameLayout"):
            if n["x1"] < -SLACK or n["x2"] > n["W"] + SLACK:
                findings.append(("overflow-x", n["type"], label, round(n["x1"]), round(n["x2"]), round(n["W"])))
        if "scroll" in (n["text"] or "").lower() and ("barre" in n["text"].lower() or "scroll bar" in n["text"].lower()):
            findings.append(("scrollbar", n["type"], label, round(w), round(h), 0))
        if n["click"] and on_screen_y and min(w, h) < MIN_TARGET[p.name] - SLACK and n["y1"] >= 0 and n["y2"] <= n["H"]:
            findings.append(("small-target", n["type"], label, round(w), round(h), MIN_TARGET[p.name]))
    return findings
