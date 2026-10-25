import { client } from './chat.mjs';
import { until, evaluate } from './cdp.mjs';
import { communityTab, openCommunity, permissionGrid, PERMISSION_GRID_DRAWN } from './comm.mjs';
const cx = await client(9224, null, { focus: false });
try { await openCommunity(cx, 'Canari Test Venue'); } catch (e) { console.log('open:', String(e.message).slice(0, 300)); console.log(await evaluate(cx, 'location.pathname')); process.exit(1); }
await communityTab(cx, 'roles');
await until(cx, PERMISSION_GRID_DRAWN, 15000);
console.log(JSON.stringify(await permissionGrid(cx)));
process.exit(0);
