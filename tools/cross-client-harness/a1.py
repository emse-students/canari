# -*- coding: utf-8 -*-
"""
Native-surface driver for A1 (Pixel 6a, Android 17 / SDK 37), for the cross-client test campaign
(docs/wiki/cross-client-testing.md).

WHY THIS EXISTS ALONGSIDE cdp.mjs. Canari on Android is a Tauri WebView, so almost every in-app
interaction is better done over CDP against that WebView (real DOM selectors, real app state,
localStorage) - see cdp.mjs. What CDP cannot reach is everything OUTSIDE the WebView, and that is
exactly what half this campaign is about: the notification shade, permission dialogs, the launcher,
system settings, the lock screen. That is this file.

WHY NOT THE android-mcp SERVER. It is installed and patched and works, but its tools only load at
Claude Code startup and its API is coordinate-based. uiautomator2 - the same library it wraps -
selects by resource-id and text, which is what an unattended campaign needs. No restart, better
selectors.

DEVICE TRAP, already paid for: `d.info` throws on SDK 37 ("ApplicationSharedMemory not
initialized" out of UiDevice.getDisplaySizeDp) and `adb shell uiautomator dump` fails with
"could not get idle state" - while uiautomator2's own dump_hierarchy() is fine. So: never .info,
never the native dump.

Usage:
    python a1.py info
    python a1.py dump [filter]        # compact tree, optional case-insensitive substring filter
    python a1.py click "Autoriser"    # by text, then description, then resource-id
    python a1.py clickid com.android.foo:id/bar
    python a1.py xy 540 1200
    python a1.py type "hello"
    python a1.py key home|back|enter|recent|power
    python a1.py notif                # expand the shade and dump it
    python a1.py screenshot out.png
    python a1.py swipe 540 1600 540 600
"""

import os
import re
import subprocess
import sys
import xml.etree.ElementTree as ET

import uiautomator2 as u2

PACKAGE = "fr.emse.canari"


def resolve_serial() -> str | None:
    """
    The device to drive, NEVER guessed.

    `u2.connect()` with no argument delegates to adbutils, which raises as soon as more than one
    transport is attached - and this phone is routinely attached TWICE, because its USB link drops on
    its own so every long run promotes it to `adb tcpip 5555`. That made a whole NOTIF-7 run abort at
    the tap with "more than one device/emulator", after the notification it was meant to tap had
    already been found: a harness fault, not a product one.

    `ANDROID_SERIAL` wins when the caller knows which transport it is already using (its logcat
    capture is bound to one of them). Otherwise prefer the WIRELESS entry, which is the one that
    survives - same rule as `watch.mjs`, and for the same reason.
    """
    explicit = os.environ.get("ANDROID_SERIAL")
    if explicit:
        return explicit
    out = subprocess.run(
        ["adb", "devices"], capture_output=True, text=True, timeout=30
    ).stdout
    serials = [
        line.split("\t")[0]
        for line in out.splitlines()[1:]
        if line.strip() and line.strip().endswith("device")
    ]
    if not serials:
        return None
    wireless = [s for s in serials if ":" in s]
    return wireless[0] if wireless else serials[0]


def device():
    """Connects without ever touching `.info` - see the module docstring."""
    d = u2.connect(resolve_serial())
    d.window_size()  # cheap liveness probe that answers over adb on SDK 37
    return d


def compact(xml_text: str, needle: str = "") -> list[str]:
    """Flattens the hierarchy to the nodes a human or an agent could act on."""
    rows: list[str] = []
    for node in ET.fromstring(xml_text).iter("node"):
        text = (node.get("text") or "").strip()
        desc = (node.get("content-desc") or "").strip()
        rid = (node.get("resource-id") or "").strip()
        clickable = node.get("clickable") == "true"
        if not (text or desc or (rid and clickable)):
            continue
        bounds = node.get("bounds") or ""
        m = re.match(r"\[(\d+),(\d+)\]\[(\d+),(\d+)\]", bounds)
        centre = ""
        if m:
            x1, y1, x2, y2 = (int(g) for g in m.groups())
            centre = f"@{(x1 + x2) // 2},{(y1 + y2) // 2}"
        parts = [node.get("class", "").rsplit(".", 1)[-1]]
        if text:
            parts.append(f'text="{text}"')
        if desc:
            parts.append(f'desc="{desc}"')
        if rid:
            parts.append(f"id={rid}")
        if clickable:
            parts.append("CLICKABLE")
        parts.append(centre)
        row = " ".join(p for p in parts if p)
        if needle and needle.lower() not in row.lower():
            continue
        rows.append(row)
    return rows


def click_anything(d, label: str) -> bool:
    """Text, then content-description, then resource-id. Returns whether something was hit."""
    for selector in (
        {"text": label},
        {"textContains": label},
        {"description": label},
        {"descriptionContains": label},
        {"resourceId": label},
    ):
        el = d(**selector)
        if el.exists:
            el.click()
            print(f"[OK] clicked {selector}")
            return True
    print(f"[FAIL] nothing matches {label!r}")
    return False


def main() -> int:
    cmd = sys.argv[1] if len(sys.argv) > 1 else "info"
    args = sys.argv[2:]
    d = device()

    if cmd == "info":
        print(f"window_size={d.window_size()}")
        print(f"current={d.app_current()}")
        print(f"serial={d.serial}")
        try:
            print(f"canari={d.app_info(PACKAGE)}")
        except Exception as exc:  # noqa: BLE001 - the app may simply not be installed yet
            print(f"canari=absent ({exc})")

    elif cmd == "dump":
        rows = compact(d.dump_hierarchy(), args[0] if args else "")
        print(f"--- {len(rows)} actionable nodes ---")
        for row in rows:
            print(row)

    elif cmd == "click":
        return 0 if click_anything(d, args[0]) else 1

    elif cmd == "clickid":
        el = d(resourceId=args[0])
        if not el.exists:
            print(f"[FAIL] no resource-id {args[0]}")
            return 1
        el.click()
        print("[OK] clicked")

    elif cmd == "xy":
        d.click(int(args[0]), int(args[1]))
        print(f"[OK] tapped {args[0]},{args[1]}")

    elif cmd == "type":
        d.send_keys(args[0])
        print(f"[OK] typed {len(args[0])} chars")

    elif cmd == "key":
        d.press(args[0])
        print(f"[OK] key {args[0]}")

    elif cmd == "notif":
        d.open_notification()
        rows = compact(d.dump_hierarchy())
        print(f"--- shade: {len(rows)} nodes ---")
        for row in rows:
            print(row)

    elif cmd == "notiftap":
        # Expand the shade and tap a notification, in ONE process.
        #
        # Two separate a1.py invocations (`notif` then `click`) meant two connections to the ATX
        # agent on the device, and the second reliably died with `RemoteDisconnected` right after
        # the shade had been expanded - so NOTIF-7 aborted with a notification it had already found
        # sitting in front of it. One connection, one expansion, one tap.
        #
        # The dump is printed BEFORE the tap on purpose: if the tap misses, the log still says what
        # was on screen, which is the difference between "the deep link is broken" and "the locator
        # was a guess".
        d.open_notification()
        import time as _time

        _time.sleep(1.5)
        rows = compact(d.dump_hierarchy())
        print(f"--- shade: {len(rows)} nodes ---")
        for row in rows:
            print(row)
        return 0 if click_anything(d, args[0]) else 1

    elif cmd == "screenshot":
        d.screenshot(args[0])
        print(f"[OK] saved {args[0]}")

    elif cmd == "swipe":
        d.swipe(int(args[0]), int(args[1]), int(args[2]), int(args[3]), 0.2)
        print("[OK] swiped")

    else:
        print(f"[FAIL] unknown command {cmd}")
        return 1

    return 0


if __name__ == "__main__":
    sys.exit(main())
