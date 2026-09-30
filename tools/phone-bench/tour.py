"""The screen tour: every step is checked, so a failure says where and a pass means the screen was there.

    python tour.py <android|ios|both> [screen-name-prefix]

A screen is (name, root tab, taps, expect, gone):
  taps    texts to tap in order from the root tab; the LAST is the timed one. A text is looked up in
          the UI tree and, when it is not on screen, the page is scrolled to bring it (the iPhone's
          floating tab bar hides the bottom of every page).
  expect  texts of which at least one must appear after the last tap - the proof of arrival
  gone    texts that must have disappeared (proof of leaving the root page)
Each row in RUNS/tour.ndjson is `ok`, or `fail` with the step that failed, plus a screenshot taken
AFTER the checks, so a picture is always of the screen that was verified. Nothing here submits,
deletes, signs out or touches the PIN.
"""

import sys
import time

from bench import IOS_TABS, find_tab, record, shot, timed_action
from phones import Android, IOS, unlock_app

BAR = 0.9  # below this the tab bar (and on iPhone its glass) may hide an element
GRID = (0.79, 0.075)  # the apps-grid icon, in the header of both phones (no label on either)

# name, tab, taps, expect, gone
SCREENS = [
    ("tab-feed", "Feed", [], ["Associations"], []),
    ("tab-communities", "Communaut", [], ["Ajouter un canal", "general"], []),
    ("tab-discussions", "Discussions", [], [], []),
    ("tab-dashboard", "Tableau de bord", [], ["Accès rapide"], []),
    ("dash-profile", "Tableau de bord", ["Profil"], ["À propos de moi"], ["Accès rapide"]),
    ("dash-settings", "Tableau de bord", ["Param"], ["Préférences"], ["Accès rapide"]),
    ("dash-agenda", "Tableau de bord", ["Agenda"], ["Agenda des associations"], ["Accès rapide"]),
    ("dash-shop", "Tableau de bord", ["Boutique"], ["Cotisations, recharges"], ["Accès rapide"]),
    ("dash-associations", "Tableau de bord", ["Associations"], [], ["Accès rapide"]),
    ("dash-forms", "Tableau de bord", ["Formulaires"], [], ["Accès rapide"]),
    ("header-profile", "Feed", ["Accéder au profil"], ["À propos de moi"], ["Associations"]),
    ("header-notifs", "Feed", ["Notifs"], ["Non lu", "Cette semaine"], ["Associations"]),
    ("header-compose", "Feed", ["Publier"], ["Nouvelle publication"], []),
    ("header-search", "Feed", ["Rechercher"], ["Rechercher dans les posts", "Effacer"], []),
    ("header-grid", "Tableau de bord", ["@grid"], [], []),
]


def visible(p, text):
    """First tree entry starting with `text` that is on screen above the tab bar, or None."""
    for e in p.tree():
        if e["text"].startswith(text) and 0.03 < e["fy"] < BAR and 0 < e["fx"] < 1:
            return e
    return None


def present(p, texts):
    tree = p.tree()
    return any(e["text"].startswith(t) or t in e["text"] for e in tree for t in texts if e["fy"] > 0.0)


def find_scrolling(p, text):
    """Looks for `text` and scrolls the page up to four times to reach it, then scrolls back."""
    for i in range(5):
        e = visible(p, text)
        if e:
            return e, i
        p.swipe(0.5, 0.75, 0.5, 0.35, 0.3)
        time.sleep(0.6)
    return None, 5


def recover(p):
    """A modal is closed through its Fermer/Annuler button, a page without a tab bar through Back."""
    for _ in range(3):
        if p.keyboard_up():
            p.hide_keyboard()
            time.sleep(0.6)
        tree = p.tree()
        close = next((e for e in tree if e["text"].startswith(("Fermer", "Annuler")) and e["type"].endswith(("Button", "View")) and e["fy"] < 0.9), None)
        bar = any(e["fy"] > BAR and (e["text"].startswith("Feed") or e["type"] == "TabBar") for e in tree)
        if close:
            p.tap(close["fx"], close["fy"])
        elif not bar:
            p.back()
        else:
            return
        time.sleep(0.8)


def root(p, tab):
    """Lands on `tab` FROM another tab so the tap is a real navigation, and leaves the feed on 'Tout'."""
    other = "Tableau de bord" if tab != "Tableau de bord" else "Feed"
    for t in (other, tab):
        pos = find_tab(p, t)
        p.tap(pos["fx"], pos["fy"])
        time.sleep(1.2)
    if tab == "Feed":
        tout = visible(p, "Tout")
        if tout:
            p.tap(tout["fx"], tout["fy"])
            time.sleep(0.8)


def run_screen(p, name, tab, taps, expect, gone):
    row = {"phone": p.name, "screen": name, "tab": tab}
    recover(p)
    root(p, tab)
    action = None
    if taps:
        for t in taps[:-1]:
            e, _ = find_scrolling(p, t)
            if not e:
                return {**row, "status": "fail", "step": f"pre-tap {t!r} not found"}
            p.tap(e["fx"], e["fy"])
            time.sleep(1.5)
        last = taps[-1]
        if last == "@grid":
            target = {"fx": GRID[0], "fy": GRID[1]}
        else:
            target, scrolled = find_scrolling(p, last)
            row["scrolled"] = scrolled
            if not target:
                return {**row, "status": "fail", "step": f"{last!r} not found (scrolled 4x)"}
        action = lambda: p.tap(target["fx"], target["fy"])
    else:
        other = "Tableau de bord" if tab != "Tableau de bord" else "Feed"
        pos = find_tab(p, other)
        p.tap(pos["fx"], pos["fy"])
        time.sleep(1.5)
        dest = find_tab(p, tab)
        action = lambda: p.tap(dest["fx"], dest["fy"])
    first, settled, dispatch, _, _ = timed_action(p, action, window=2.0)
    row.update(first_ms=first, settled_ms=settled, dispatch_ms=dispatch)
    time.sleep(0.4)
    if expect and not present(p, expect):
        row.update(status="fail", step=f"none of {expect} on screen")
    elif gone and present(p, gone):
        row.update(status="fail", step=f"{gone} still on screen")
    else:
        row["status"] = "ok"
    row["shot"] = shot(p, name)
    return row


def main(which, prefix):
    phones = [P for P in (Android, IOS) if which in ("both", P.__name__.lower())]
    for P in phones:
        p = P()
        if unlock_app(p):
            print(p.name, "PIN keypad was up: unlocked")
        for name, tab, taps, expect, gone in SCREENS:
            if prefix and not name.startswith(prefix):
                continue
            try:
                row = run_screen(p, name, tab, taps, expect, gone)
            except Exception as e:
                row = {"phone": p.name, "screen": name, "status": "fail", "step": "exception " + repr(e)[:160]}
            record("tour", row)
            print(f"{p.name:10} {name:18} {row['status']:4} first={row.get('first_ms')} settled={row.get('settled_ms')} {row.get('step', '')}", flush=True)
        recover(p)


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "both", sys.argv[2] if len(sys.argv) > 2 else "")
