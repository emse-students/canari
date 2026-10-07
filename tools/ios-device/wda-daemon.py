"""
Keeps the WebDriverAgent runner alive on the connected iPhone and exposes it on localhost:8100.

    python tools/ios-device/wda-daemon.py            # runs until Ctrl-C, one per phone

WHY A DAEMON. The runner lives exactly as long as the process that started it: `pymobiledevice3
developer wda ... -xc` starts one per command and stops it on exit, which costs seconds per action
and leaves no session to reuse. This starts it ONCE and forwards the phone's port 8100 over usbmux
to the same port here, so everything else is plain W3C WebDriver over HTTP - the iPhone's
counterpart of `adb`, which is what `tools/ios-device/ios.mjs` speaks. Port 8100 is what WDA
listens on by default.

The runner is `fr.emse.canari.wda.xctrunner`, installed by `sign-install.mjs`'s sibling procedure
(docs/wiki/frontend/mobile.md#a-build-for-the-phone-on-the-bench).
"""

import asyncio
import logging
import socket
import sys
import urllib.error
import urllib.request

from pymobiledevice3 import usbmux
from pymobiledevice3.lockdown import create_using_usbmux
from pymobiledevice3.cli.developer.wda import wait_for_xctest_app
from pymobiledevice3.remote import userspace_tunnel
from pymobiledevice3.utils import get_asyncio_loop

RUNNER = "fr.emse.canari.wda.xctrunner"
PORT = 8100
# WDA's MJPEG screen stream, which the bench reads to time what the screen does. Same forward.
MJPEG_PORT = 9100
log = logging.getLogger("wda-daemon")


async def pipe(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
    """Copies one direction of a forwarded connection until either end closes."""
    try:
        while data := await reader.read(65536):
            writer.write(data)
            await writer.drain()
    except (ConnectionError, asyncio.CancelledError):
        pass
    finally:
        writer.close()


async def forward(udid: str, port: int, client_r: asyncio.StreamReader, client_w: asyncio.StreamWriter) -> None:
    """Bridges one local connection to one of the phone's WDA ports through usbmux."""
    device = await usbmux.select_device(udid)
    if device is None:
        log.error("device %s left usbmux; dropping a forwarded connection", udid)
        client_w.close()
        return
    sock = await device.connect(port)
    # usbmux hands back a plain socket; asyncio streams are made from it here.
    dev_r, dev_w = await asyncio.open_connection(sock=sock)
    await asyncio.gather(pipe(client_r, dev_w), pipe(dev_r, client_w))


def refuse_if_ports_are_held() -> None:
    """Stops BEFORE the tunnel when another process already holds a forwarded port.

    A second daemon used to get through the whole tunnel and runner start and only then die on
    `OSError 10048`, with no hint whose port it was (found 2026-10-02). The question is answerable
    up front: bind each port, and when 8100 is taken ask it `/status` - a WDA answering there is
    another daemon, which is the usual case and needs no second one.
    """
    for port in (PORT, MJPEG_PORT):
        probe = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        try:
            probe.bind(("127.0.0.1", port))
        except OSError:
            holder = "something that is not WDA"
            try:
                with urllib.request.urlopen(f"http://127.0.0.1:{PORT}/status", timeout=3) as r:
                    holder = f"a WDA already answering /status ({r.status}) - another wda-daemon.py is running"
            except (urllib.error.URLError, OSError) as e:
                log.debug("port %d held and /status unreadable: %s", port, e)
            log.error("port %d is already in use by %s; stop it or reuse it, refusing to start", port, holder)
            sys.exit(1)
        finally:
            probe.close()


async def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s")
    refuse_if_ports_are_held()
    lockdown = await create_using_usbmux()
    udid = lockdown.udid
    log.info("starting %s on %s (iOS %s)", RUNNER, udid, lockdown.product_version)
    # A TUNNEL, NOT THE PLAIN LOCKDOWN. From iOS 17 the developer services (instruments, testmanagerd)
    # are only reachable over a Remote Service Discovery tunnel, and the plain lockdown answers
    # `InvalidService` to the instruments service - which is what the first version of this file
    # died on, and why `pymobiledevice3`'s own commands work: they catch that and retry through a
    # tunnel. This one is the userspace kind (an in-process TCP stack over the CoreDeviceProxy
    # service), so it needs no administrator rights, unlike `start-tunnel`.
    rsd = await userspace_tunnel.establish_userspace_rsd(serial=udid)
    log.info("tunnel up")
    # THE CLI's OWN STARTER, not a copy: it starts the runner and returns only once WDA answers on
    # the phone's port, which is the one readiness signal there is.
    runner = await wait_for_xctest_app(rsd, RUNNER)

    servers = [
        await asyncio.start_server(lambda r, w, p=port: forward(udid, p, r, w), "127.0.0.1", port)
        for port in (PORT, MJPEG_PORT)
    ]
    log.info("WDA forwarded on http://127.0.0.1:%d, MJPEG on %d - Ctrl-C to stop", PORT, MJPEG_PORT)
    tasks = {asyncio.create_task(srv.serve_forever()) for srv in servers}
    await asyncio.wait({runner, *tasks}, return_when=asyncio.FIRST_COMPLETED)
    if runner.done():
        runner.result()
        log.error("the runner exited; the daemon stops with it")
        sys.exit(1)


if __name__ == "__main__":
    # THE LIBRARY'S OWN LOOP, which is what its CLI runs everything on: under `asyncio.run` the very
    # same calls answered `InvalidService` for the instruments service, so a fresh loop is not
    # equivalent here.
    try:
        get_asyncio_loop().run_until_complete(main())
    except KeyboardInterrupt:
        pass
