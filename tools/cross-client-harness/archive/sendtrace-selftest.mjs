/**
 * Pins `sendsByDevice` and `mobileNavOrder` - the two readers the iPhone needs because what the
 * WebView sees is not what the app does (2026-10-01): its API calls go through the Rust HTTP plugin,
 * and its tab bar is a native UITabBar with untitled items.
 */
import { readFileSync } from 'node:fs';
import { sendsByDevice } from '../sendtrace.mjs';
import { mobileNavOrder } from '../phone-ios.mjs';

let failures = 0;
const check = (label, actual, expected) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    failures += 1;
    console.log(`FAIL ${label}\n  expected ${JSON.stringify(expected)}\n  actual   ${JSON.stringify(actual)}`);
  }
};

const U = 'f7a9bb80'.repeat(8);
const DEV = `tauri-${U}-mupb1gtc-k9w8`;
const lines = [
  `[Nest] 1  - LOG [MessagingService] [SEND][send-a] START group=g1 sender=${U}:${DEV} hasProto=true isWelcome=false isCommit=false`,
  `[Nest] 1  - LOG [MessagingService] [SEND][send-b] START group=g1 sender=${U}:web-${U}-x-y hasProto=true`,
  `[Nest] 1  - WARN [MessagingService] [SEND][send-a] MEMBERS_CACHE_REPAIRED group=g1 added=7 of=7`,
  `[Nest] 1  - LOG [MessagingService] [SEND][send-a] DONE queued=6 realtime=2`,
  `[Nest] 1  - LOG [MessagingService] [SEND][send-b] DONE queued=6 realtime=2`,
  `[Nest] 1  - LOG [MessagingService] [SEND][send-c] START group=g2 sender=${U}:${DEV} hasProto=true`,
];

check('only THIS device, in order, each with its outcome', sendsByDevice(lines, DEV), [
  { trace: 'send-a', group: 'g1', sender: U, done: true, queued: 6 },
  { trace: 'send-c', group: 'g2', sender: U, done: false, queued: null },
]);
check('another device of the same user is not ours', sendsByDevice(lines, `web-${U}-x-y`).length, 1);
check('a DONE for a trace we did not start is ignored', sendsByDevice(lines.slice(2, 5), DEV), []);
check('no lines, no sends', sendsByDevice([], DEV), []);

const PLACES = `export interface AppPlace {
  id: string;
  mobileNav: boolean;
}
export const APP_PLACES = [
  { id: 'posts', label: () => m.a(), href: '/posts', mobileNav: true },
  { id: 'communities', href: '/communities', mobileNav: true },
  { id: 'chat', href: '/chat', mobileNav: true },
  { id: 'notifications', href: '/notifications', mobileNav: false },
  { id: 'dashboard', href: '/dashboard', mobileNav: true },
];`;
check('the bar order is the mobileNav entries in declaration order', mobileNavOrder(PLACES), [
  'posts',
  'communities',
  'chat',
  'dashboard',
]);

// AND AGAINST THE APP'S OWN FILE: a reshaped `places.ts` the regex no longer reads must fail HERE,
// not as a tap on the wrong tab four rows later.
const real = mobileNavOrder(
  readFileSync(new URL('../../../frontend/src/lib/navigation/places.ts', import.meta.url), 'utf8')
);
check('the real places.ts yields a bar that holds the chat tab', real.includes('chat') && real.length >= 3, true);

if (failures > 0) {
  console.log(`\nsendtrace-selftest: ${failures} failure(s)`);
  process.exit(1);
}
console.log('sendtrace-selftest: ok');
