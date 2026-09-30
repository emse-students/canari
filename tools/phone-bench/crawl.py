"""Visit every reachable screen on both phones: time the transition, audit the layout, screenshot it.

    python crawl.py [start-at-name]

A screen is a name plus the taps that reach it from a known root (a bottom tab). Taps are by TEXT
from the UI tree, never by coordinate, except the iPhone's unlabelled tab icons. Navigation only:
nothing here submits, deletes, signs out or touches the PIN, and a screen's OWN tappable texts are
recorded as `candidates` so the next pass can be written from what the app really offers.
Results: RUNS/crawl.ndjson; screenshots in RUNS/shots/ (outside the repo).
"""

import sys
import time

from audit import audit
from bench import IOS_TABS, find_tab, record, shot, timed_action
from phones import Android, IOS

# (screen, root tab, [texts to tap in order]) - a text matches a tree entry that STARTS with it.
SCREENS = [
    ("tab-feed", "Feed", []),
    ("tab-communities", "Communaut", []),
    ("tab-discussions", "Discussions", []),
    ("tab-dashboard", "Tableau de bord", []),
    ("dash-profile", "Tableau de bord", ["Profil"]),
    ("dash-settings", "Tableau de bord", ["Param"]),
    ("dash-agenda", "Tableau de bord", ["Agenda"]),
    ("dash-shop", "Tableau de bord", ["Boutique"]),
    ("dash-associations", "Tableau de bord", ["Associations"]),
    ("dash-forms", "Tableau de bord", ["Formulaires"]),
    ("header-profile", "Feed", ["Accéder au profil"]),
    ("header-notifs", "Feed", ["Notifs"]),
    ("header-search", "Feed", ["Rechercher"]),
    ("header-compose", "Feed", ["Publier"]),
    ("header-sites", "Tableau de bord", ["Nos autres sites"]),
]
TAB_BAR = 0.9


def tap_text(p, text):
    """Taps the first non-tab-bar tree entry starting with `text`; returns it or None."""
    for e in p.tree():
        if e["fy"] < TAB_BAR and e["text"].startswith(text):
            p.tap(e["fx"], e["fy"])
            return e
    return None


def go_root(p, tab):
    for _ in range(3):
        pos = find_tab(p, tab)
        p.tap(pos["fx"], pos["fy"])
        time.sleep(1.2)
        if pos:
            return


def recover(p):
    """Closes whatever is open: a modal through its Fermer button, a page that hides the tab bar
    through Back. Nothing is pressed when the tab bar is already reachable."""
    for _ in range(3):
        tree = p.tree()
        close = next((e for e in tree if e["text"].startswith(("Fermer", "Annuler")) and e["type"] in ("Button", "View")), None)
        bar = any(e["fy"] > TAB_BAR and (e["text"].startswith("Feed") or e["type"] == "TabBar") for e in tree)
        if close:
            p.tap(close["fx"], close["fy"])
        elif not bar:
            p.back()
        else:
            return
        time.sleep(0.8)


def candidates(p):
    skip = ("Déconnexion", "Déconnecter")
    return sorted({e["text"][:40] for e in p.tree() if e["fy"] < TAB_BAR and e["type"] in ("Button", "Link", "ToggleButton", "View") and e["text"] and not e["text"].startswith(skip)})[:40]


def visit(p, name, tab, taps):
    recover(p)
    go_root(p, "Feed" if tab != "Feed" and not taps and False else tab)
    if not taps:  # a tab screen is measured from ANOTHER tab, or nothing moves
        go_root(p, "Tableau de bord" if tab != "Tableau de bord" else "Feed")
    row = {"phone": p.name, "screen": name, "tab": tab, "taps": taps}
    if taps:
        for t in taps[:-1]:
            if tap_text(p, t) is None:
                row["error"] = f"missing {t!r}"
                return record("crawl", row)
            time.sleep(1.5)
        target = None
        for e in p.tree():
            if e["fy"] < TAB_BAR and e["text"].startswith(taps[-1]):
                target = e
                break
        if target is None:
            row["error"] = f"missing {taps[-1]!r}"
            return record("crawl", row)
        first, settled, dispatch, _, _ = timed_action(p, lambda: p.tap(target["fx"], target["fy"]), window=2.0)
        row.update(first_ms=first, settled_ms=settled, dispatch_ms=dispatch)
    else:
        first, settled, dispatch, _, _ = timed_action(p, lambda: p.tap(*((find_tab(p, tab)["fx"], find_tab(p, tab)["fy"]))), window=2.0)
        row.update(first_ms=first, settled_ms=settled, dispatch_ms=dispatch)
    time.sleep(0.5)
    findings = audit(p)
    row["findings"] = findings
    row["candidates"] = candidates(p)
    row["shot"] = shot(p, name)
    print(p.name, name, "first", row.get("first_ms"), "settled", row.get("settled_ms"), "findings", len(findings))
    return record("crawl", row)


if __name__ == "__main__":
    start = sys.argv[1] if len(sys.argv) > 1 and sys.argv[1] != "-" else None
    which = sys.argv[2] if len(sys.argv) > 2 else "both"
    phones = [p for p in (Android, IOS) if which in ("both", p.__name__.lower())]
    phones = [P() for P in phones]
    for p in phones:
        live = start is None
        for name, tab, taps in SCREENS:
            live = live or name == start
            if live:
                try:
                    visit(p, name, tab, taps)
                except Exception as e:  # one broken screen must not end the tour
                    print(p.name, name, "FAILED", repr(e)[:160])
                    record("crawl", {"phone": p.name, "screen": name, "error": repr(e)[:300]})
