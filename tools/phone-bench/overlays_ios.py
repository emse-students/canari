"""Every overlay the iPhone can open from each screen, audited against the status bar, the home
indicator and the floating tab bar - the iPhone half of `insets.mjs` (the release WebView cannot be
inspected, so this reads the accessibility tree instead).

    python overlays_ios.py [screen-name-prefix]

For each screen of `tour.SCREENS`, the controls whose label OPENS something (menu, filters, settings,
new, add, see ...) are tapped, one at a time, never one that commits (send, delete, pay, sign out, PIN).
When something opened, the tree is read and:
  B  an interactive node lies under the tab bar it is not part of - the control cannot be reached
  X  an interactive node starts inside the status-bar zone (above SAFE_TOP) or ends inside the
     home-indicator zone (below H - SAFE_BOTTOM)
  O  a node leaves the screen sideways
and a screenshot is kept. Rows go to RUNS/overlays-ios.ndjson, pictures to RUNS/ins/ios/ - outside the repo.
"""

import os
import re
import sys
import time

from bench import RUNS, record
from phones import IOS, unlock_app
from tour import SCREENS, recover, root, visible

SAFE_TOP, SAFE_BOTTOM = 47, 34  # iPhone 12, points
OPENS = re.compile(r"(plus d.actions|menu|filtr|param|r[eé]glage|nouveau|nouvelle|ajouter|cr[eé]er|voir|g[eé]rer|r[eé]agi|r[eé]action|partager|modifier|rechercher|profil|notifs|autres sites|commenter|r[eé]pondre|d[eé]tails|options|emoji|pi[eè]ce|joindre|publier$|photo|canal)", re.I)
NEVER = re.compile(r"(supprimer|d[eé]connex|quitter|r[eé]voquer|r[eé]initial|envoyer|confirmer|valider|enregistrer|payer|acheter|pin|effacer|bloquer|signaler|retirer|bannir)", re.I)
INTERACTIVE = ("Button", "Link", "Switch", "TextField", "SecureTextField", "Tab", "Cell", "SearchField")


def audit_nodes(nodes):
    bar = next((n for n in nodes if n["type"] == "TabBar"), None)
    out = {"B": [], "X": [], "O": []}
    for n in nodes:
        if n.get("visible") is False or n["x2"] <= n["x1"] or n["y2"] <= n["y1"]:
            continue
        label = (n["text"] or n["type"])[:30]
        if n["type"] not in INTERACTIVE:
            continue
        in_bar = bar is not None and bar["x1"] - 2 <= n["x1"] and n["x2"] <= bar["x2"] + 2 and bar["y1"] - 2 <= n["y1"]
        if n["y1"] < SAFE_TOP - 1 and n["y2"] > 0:
            out["X"].append(f"{n['type']} {label} top {round(n['y1'])}")
        elif n["y2"] > n["H"] - SAFE_BOTTOM + 1 and n["y1"] < n["H"] and not in_bar:
            out["X"].append(f"{n['type']} {label} bottom {round(n['y2'])}")
        if bar is not None and not in_bar:
            cx, cy = (n["x1"] + n["x2"]) / 2, (n["y1"] + n["y2"]) / 2
            if bar["x1"] < cx < bar["x2"] and bar["y1"] < cy < bar["y2"]:
                out["B"].append(f"{n['type']} {label} under bar")
        if n["x1"] < -2 or n["x2"] > n["W"] + 2:
            out["O"].append(f"{n['type']} {label} {round(n['x1'])}..{round(n['x2'])}")
    return {k: {"n": len(v), "ex": v[:3]} for k, v in out.items()}


def reach(p, name, tab, taps):
    recover(p)
    root(p, tab)
    for t in taps:
        e = visible(p, t)
        if e:
            p.tap(e["fx"], e["fy"])
            time.sleep(1.3)


def main(prefix):
    p = IOS()
    unlock_app(p)
    shots = os.path.join(RUNS, "ins", "ios")
    os.makedirs(shots, exist_ok=True)
    for name, tab, taps, expect, gone in SCREENS:
        if (taps and taps[-1] == "@grid") or (prefix and not name.startswith(prefix)):
            continue
        reach(p, name, tab, taps)
        base_sig = {n["text"] for n in p.nodes() if n["text"]}
        labels = []
        for e in p.tree():
            if e["type"] in ("Button", "Link", "Switch") and 0.03 < e["fy"] < 0.9 and OPENS.search(e["text"]) and not NEVER.search(e["text"]):
                if e["text"] not in [l[0] for l in labels]:
                    labels.append((e["text"], e["fx"], e["fy"]))
        opened = 0
        for label, fx, fy in labels[:8]:
            p.tap(fx, fy)
            time.sleep(0.9)
            nodes = p.nodes()
            sig = {n["text"] for n in nodes if n["text"]}
            dialog = any("boîte de dialogue" in n["text"] or n["text"].startswith(("Fermer", "Annuler")) for n in nodes)
            if dialog or len(sig - base_sig) > 4:
                opened += 1
                audit = audit_nodes(nodes)
                pic = os.path.join(shots, re.sub(r"[^\w-]+", "_", f"{name}--{label}")[:90] + ".png")
                p.screenshot(pic)
                record("overlays-ios", {"screen": name, "overlay": label, "dialog": dialog, "audit": audit, "shot": pic})
                print(f"{name:18} {label[:28]:28} B{audit['B']['n']} X{audit['X']['n']} O{audit['O']['n']}", flush=True)
            reach(p, name, tab, taps)
        print(f"{name}: {opened} overlays of {len(labels[:8])} tried", flush=True)


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "")
