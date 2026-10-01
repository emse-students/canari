/**
 * Pins `consoleorigin.mjs` and its use in `report()`: a console line another origin emitted (the
 * identity provider's, during a login) is REPORTED as foreign and does not break `clean`, while the
 * application's own line from its own origin still does. Fake CDP buffers - no browser.
 */
import {
  contextOrigins,
  isForeignOrigin,
  originOfConsoleEvent,
  originOfUrl,
} from '../consoleorigin.mjs';
import { report } from '../watch.mjs';

let failures = 0;
const check = (label, actual, expected) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    failures += 1;
    console.log(`FAIL ${label}\n  expected ${JSON.stringify(expected)}\n  actual   ${JSON.stringify(actual)}`);
  }
};

const SITE = 'http://localhost:8081';
const IDP = 'https://auth.example.test';

check('origin of an app url', originOfUrl(`${SITE}/_app/x.js`), SITE);
check('origin of a tauri url', originOfUrl('tauri://localhost/index.html'), 'tauri://localhost');
check('a relative or odd url has no origin', [originOfUrl('/x'), originOfUrl('about:blank'), originOfUrl(null)], [null, null, null]);

const ctx = contextOrigins([
  { method: 'Runtime.executionContextCreated', params: { context: { id: 1, origin: SITE } } },
  { method: 'Runtime.executionContextCreated', params: { context: { id: 2, origin: IDP } } },
  { method: 'Runtime.executionContextCreated', params: { context: { id: 3, origin: 'null' } } },
]);
const consoleEvent = (id, text, extra = {}) => ({
  method: 'Runtime.consoleAPICalled',
  params: { type: 'log', timestamp: 1_786_710_000_000, args: [{ value: text }], executionContextId: id, ...extra },
});
check('a console line takes its context origin', originOfConsoleEvent(consoleEvent(2, 'x'), ctx), IDP);
check('a null-origin context is unattributed', originOfConsoleEvent(consoleEvent(3, 'x'), ctx), null);
check(
  'no context: the top stack frame url answers',
  originOfConsoleEvent(consoleEvent(99, 'x', { stackTrace: { callFrames: [{ url: `${IDP}/a.js` }] } }), ctx),
  IDP
);
check(
  'a NETWORK log entry is never an emitter - its url is the resource',
  originOfConsoleEvent({ method: 'Log.entryAdded', params: { entry: { source: 'network', url: `${IDP}/x` } } }, ctx),
  null
);
check(
  'a javascript log entry is attributed by its url',
  originOfConsoleEvent({ method: 'Log.entryAdded', params: { entry: { source: 'javascript', url: `${IDP}/x.js` } } }, ctx),
  IDP
);

check('home is not foreign', isForeignOrigin(SITE, [SITE]), false);
check('another origin is foreign', isForeignOrigin(IDP, [SITE]), true);
check('unattributed is never foreign', isForeignOrigin(null, [SITE]), false);
check('with no home set NOTHING is foreign', isForeignOrigin(IDP, []), false);

// --- through report() -----------------------------------------------------------------------------
const events = [
  { method: 'Runtime.executionContextCreated', params: { context: { id: 1, origin: SITE } } },
  { method: 'Runtime.executionContextCreated', params: { context: { id: 2, origin: IDP } } },
  consoleEvent(2, 'authentik: some line this application never wrote'),
  consoleEvent(2, 'another IdP sentence'),
];
const handle = (evs, home) => ({ cx: { events: [...evs] }, label: 's', since: Date.now(), ...(home ? { home } : {}) });

const withHome = await report(handle(events, new Set([SITE])));
check('the IdP console does not break clean', withHome.clean, true);
check('and is reported by origin', withHome.foreignConsole, { count: 2, origins: { [IDP]: 2 } });
check('and is absent from unexplained', withHome.unexplained, []);

const unattributed = await report(handle(events));
check('with no home set the same lines stay unexplained and gate', unattributed.clean, false);

const ours = await report(handle([...events, consoleEvent(1, '[X] a line of ours nobody classified')], new Set([SITE])));
check('an unclassified line from OUR origin still breaks clean', ours.clean, false);
check('and the foreign count is untouched by it', ours.foreignConsole.count, 2);

if (failures) {
  console.log(`${failures} failure(s)`);
  process.exit(1);
}
console.log('consoleorigin-selftest OK');
