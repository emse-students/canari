/**
 * ONE NEW DEVICE, MINTED IN ITS OWN PROCESS, AND ITS RESULT AS ONE JSON LINE - for DEV-4, which needs
 * two at the same instant.
 *
 *   bun archive/mintdevice.mjs --device W3|W6
 *
 * `newdevice.mjs` binds its device from the process's own `--device` at import, so one process can
 * mint exactly one - which is right for every row but the one that asks what two enrolments do when
 * they race. `archive/devrows.mjs` starts two of these together and reads their last lines. It records
 * NOTHING itself: the verdict is DEV-4's, and a HEAL-NEW-0 row written twice by a helper would put the
 * instrument on the board. The browser is left logged in and unlocked, which is what the row reads next.
 */
import { becomeANewDeviceAndConfirm } from '../newdevice.mjs';

const r = await becomeANewDeviceAndConfirm({ report: (s) => console.error(`[mintdevice] ${s}`) });
const out = {
  refused: r.refused ?? null,
  deviceId: r.now?.deviceId ?? null,
  enrolled: r.enrolled ?? false,
  pinOk: r.pinOk ?? false,
  liveAt: r.liveAt ?? null,
};
r.cx?.close?.();
console.log(`MINTED ${JSON.stringify(out)}`);
process.exit(out.refused || !out.enrolled ? 1 : 0);
