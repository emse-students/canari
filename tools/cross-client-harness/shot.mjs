/** Saves a PNG screenshot of a client, so a layout claim is looked at rather than inferred. */
import { writeFileSync } from 'node:fs';
import { client } from './chat.mjs';

const port = Number(process.argv[2] || 9224);
const out = process.argv[3] || `shot-${port}.png`;
const cx = await client(port, port === 9222 ? null : 'canari-emse.fr');
await cx.send('Page.enable');
const res = await cx.send('Page.captureScreenshot', { format: 'png' });
writeFileSync(new URL(`./${out}`, import.meta.url), Buffer.from(res.data, 'base64'));
console.log('wrote', out);
process.exit(0);
