"""
Installs a signed IPA on the connected iPhone: AFC push, then the installation proxy.

    python tools/ios-device/install.py <signed.ipa>

WHY NOT `pymobiledevice3 apps install`. On a 45 MB IPA it hung for 25 minutes ("Unexpected AFC
opcode 14"), because it streams the archive through one AFC handle. The two halves done by hand are
what it does anyway and both are reliable: copy the file into /PublicStaging, then ask installd to
install that path.

THE RUNNING APP MUST BE DEAD, or installd accepts the request and then sits at "pending" for ever.
`sign-install.mjs` stops it (WebDriverAgent `terminate`) before it calls this.
"""

import asyncio
import inspect
import sys

from pymobiledevice3.lockdown import create_using_usbmux
from pymobiledevice3.services.afc import AfcService
from pymobiledevice3.services.installation_proxy import InstallationProxyService

REMOTE = "PublicStaging/pymobiledevice3/local.ipa"


async def resolved(value):
    """The library is sync in some releases and async in others; this takes either."""
    return await value if inspect.isawaitable(value) else value


async def main(ipa: str) -> None:
    lockdown = await resolved(create_using_usbmux())
    afc = AfcService(lockdown)
    async with afc:
        await resolved(afc.makedirs("PublicStaging/pymobiledevice3"))
        await resolved(afc.push(ipa, "/" + REMOTE))
    print("pushed", flush=True)
    proxy = InstallationProxyService(lockdown)
    async with proxy:
        await proxy.send_package("Install", {}, lambda percent, *rest: print(f"{percent}%", flush=True), REMOTE)
    print("Installation succeeded", flush=True)


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit("usage: install.py <signed.ipa>")
    asyncio.run(main(sys.argv[1]))
