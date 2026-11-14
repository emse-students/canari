/**
 * THE DEVICE PANEL'S ROW HOOK AND THE TOOL THAT READS IT MUST STILL AGREE.
 *
 *   bun purgedevices-selftest.mjs
 *
 * `purge-devices.mjs` finds the row to delete by the full device id. It read it from a `title` the
 * panel stopped rendering, so every row read "no id" and the tool refused to delete anything - found
 * by hand on 2026-11-14, weeks after the panel changed. The panel is Svelte, the tool is a CDP script,
 * and a run is the only thing that would have noticed. This reads BOTH sides, with no browser:
 *
 *   1. the panel renders `data-device-id` from the row's device id, on the row element;
 *   2. the tool walks up to `data-device-id` and reads no `title` for an id;
 *   3. the tool's walker, run over a fabricated row tree, returns the id of the row holding the
 *      delete button and nothing for a row with no device.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const panel = readFileSync(
  join(here, '../../../frontend/src/lib/components/chat/DeviceManagementPanel.svelte'),
  'utf8'
);
const tool = readFileSync(join(here, '../purge-devices.mjs'), 'utf8');

let failed = 0;
const check = (name, ok) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}`);
  if (!ok) failed += 1;
};

check(
  'the panel puts data-device-id (the row device id) on the row',
  /data-device-id=\{row\.device\?\.deviceId\}/.test(panel)
);
check('the tool reads data-device-id', tool.includes("getAttribute('data-device-id')"));
check("the tool no longer reads an id from a title", !tool.includes("div[title]"));

// The walker, extracted from the tool's own source, over a minimal tree.
const m = tool.match(/const ROW_WALKER = `(function \(b\) \{[\s\S]*?\n\})`;/);
check('the tool exposes its row walker as source', m !== null);
if (m) {
  const walker = new Function(`return ${m[1]}`)();
  const node = (attrs, parent = null) => ({
    parentElement: parent,
    getAttribute: (k) => (k in attrs ? attrs[k] : null),
  });
  const row = node({ 'data-device-id': 'web-abc-123' });
  const button = node({}, node({}, row));
  check('a button inside a device row resolves to that row', walker(button) === row);
  const orphanRow = node({});
  check('a button in a row with no device id resolves to nothing', walker(node({}, orphanRow)) === null);
}

if (failed > 0) {
  console.error(`${failed} check(s) failed`);
  process.exit(1);
}
console.log('purge-devices row hook: consistent');
