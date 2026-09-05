import { client } from '../chat.mjs';
import { evaluate } from '../cdp.mjs';
import { PORTS } from '../names.mjs';
const cx = await client(PORTS.A1);
console.log(await evaluate(cx, `JSON.stringify(
  Object.entries(performance.getEntriesByType('resource')
    .map(e => { try { return new URL(e.name).origin; } catch { return 'bad:' + e.name; } })
    .reduce((a, o) => (a[o] = (a[o] || 0) + 1, a), {}))
    .sort((a, b) => b[1] - a[1])
)`));
process.exit(0);
