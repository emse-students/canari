/**
 * COMM-18: the app is not running, a link names a salon, and the person lands IN that salon.
 *
 *   node comm18.mjs
 *
 * A COLD START IS THE HARD HALF, AND IT IS THE ONLY ONE WORTH CHECKING. A deep link into a running
 * app is a `goto`; a deep link into a process that does not exist has to survive the whole chain -
 * the intent reaching `MainActivity`, `plugin-deep-link` holding it until the webview exists,
 * `hooks.client.ts` reading it before the router has decided anything, the encryption PIN being
 * asked and answered, and only then a channel being selected that the sidebar has not finished
 * loading. Every hop can fail silently and four of them fail the same way: the app opens on its
 * default route and looks perfectly healthy.
 *
 * THE LINK IS THE ONE A NOTIFICATION CARRIES, and that is a deliberate choice over the public
 * `https://canari-emse.fr/communities` App Link. The public link is registered
 * (`AndroidManifest.xml`, `autoVerify`) and it works, but `/communities` has NO dynamic segment -
 * the route is a single page and the target conversation travels in a store, not in the path. So a
 * public link can only say "open the communities page", which is not this row. `fr.emse.canari://
 * chat/channel_<uuid>` is what `PendingIntent` puts on a channel notification, which makes this the
 * cold-start half of the path COMM-14 measures the delivery half of.
 *
 * THE PRODUCT'S OWN LINE IS THE FIRST ASSERTION, and it exists for exactly this reason:
 * `[notifNav] deep link received: <url> -> target <groupId>`, written by `hooks.client.ts`. Without
 * it the native half of the chain fails indistinguishably at four hops. It is asserted BESIDE the
 * screen, not instead of it: the line says the handler ran, the transcript says the person arrived,
 * and a run with the line and no transcript is a different defect from a run with neither.
 *
 * THE MARKER IS POSTED BEFORE THE APP IS EVEN STOPPED. A cold start that has to receive a live
 * message as well would be measuring two things and blaming this one; what this row asks is whether
 * the LANDING is right, so the salon already holds its message when the link is followed.
 *
 * `am force-stop` IS THE RIGHT KILL HERE AND IS WRONG ELSEWHERE. It puts the app in Android's
 * STOPPED state, which cancels FCM broadcasts - fatal for a push check (see
 * `docs/wiki/testing-methodology.md`), harmless for this one, because an explicit VIEW intent
 * starts a stopped app just the same. This is a link being followed, not a push being delivered.
 *
 * IT BUILDS ITS OWN VENUE and deletes it.
 */
import { awaitMessage, client, countMessage, evaluate, send } from './chat.mjs';
import {
  createChannel,
  createCommunity,
  deleteCommunity,
  enterCommunities,
  openCommunity,
  selectedChannel,
} from './comm.mjs';
import { channelIdOf, workspaceIdOf } from './grainedb.mjs';
import { ACCOUNT_OF, PORTS } from './names.mjs';
import * as phone from './phone.mjs';
import { unlockClient } from './pingate.mjs';
import { clientBuild, mark, record } from './results.mjs';
import { consoleLines, gate, report, watch } from './watch.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const w1 = await client(PORTS.W1);
const wa = await watch(w1, 'W1');

const run = mark('COMM18');
const community = `C18 ${run}`;
const salon = `c18-${run.toLowerCase()}`;
const marker = `${run}-landed`;

const failures = [];
const step = async (name, fn) => {
  try {
    return await fn();
  } catch (e) {
    failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
};

// -- The venue, and a message already in it ----------------------------------------------------
await step('create the community', async () => {
  await enterCommunities(w1);
  await createCommunity(w1, community);
  await openCommunity(w1, community);
});
const workspaceId = await step('read the community id', () => workspaceIdOf(community));

await step('create the salon and post into it', async () => {
  await enterCommunities(w1);
  await openCommunity(w1, community);
  await createChannel(w1, salon);
  await send(w1, marker);
  await awaitMessage(w1, marker, 30_000);
});
const channelId = await step('read the salon id', () =>
  workspaceId ? channelIdOf(workspaceId, salon) : null
);

// THE CONVERSATION ID, NOT THE CHANNEL ID. `channel_<uuid>` is the form every chat surface uses for
// a community salon, and it is what `chatDeepLinkRoute` reads to decide the route - a bare uuid would
// be taken for a DM group and routed to `/chat`, where this salon does not exist.
const target = channelId ? `channel_${channelId}` : null;
const link = target ? `fr.emse.canari://chat/${target}` : null;

// The phone has to be there at all, and its BUILD is part of the answer: A1's APK is deliberately
// older than the deployment, and a deep link the running code does not handle is not a defect in the
// code that ships.
const a1Before = await step('read the build the phone is running', async () => {
  const cx = await client(PORTS.A1);
  try {
    return await clientBuild(cx);
  } finally {
    cx.close();
  }
});

const armed = !!workspaceId && !!channelId && !!a1Before && (await countMessage(w1, marker)) > 0;

// -- The gesture: kill the app, then follow the link -------------------------------------------
const landing = armed
  ? await step('follow the link into a stopped app', async () => {
      phone.forceStop();
      await sleep(2000);
      const stopped = phone.pid();
      // A KILL THAT MISSED WOULD MAKE THIS A WARM START, which is a different question with the same
      // screen at the end of it. Asserted, not assumed.
      if (stopped) throw new Error(`the app is still running after force-stop (pid ${stopped}) - this would be a warm start`);

      phone.wake();
      const said = phone.sh(
        `am start -a android.intent.action.VIEW -d ${JSON.stringify(link)} ${phone.PKG}`
      );
      // `am` reports a refusal on STDOUT with exit 0, so the only way to see it is to read what it said.
      if (/Error|Warning: Activity not started/i.test(said)) {
        throw new Error(`am start refused the link: ${said.trim().split('\n').join(' | ')}`);
      }

      // The process is new, so the devtools socket is new: `ensure` re-derives the forward from the
      // CURRENT pid. Without it every read below talks to a dead socket and reports the app as
      // unresponsive - which is indistinguishable from the deep link never arriving.
      const up = await phone.ensure({ port: PORTS.A1, timeoutMs: 45_000 });
      if (!up.ok) throw new Error(`the phone never came back on devtools: ${JSON.stringify(up)}`);

      const a1 = await client(PORTS.A1);
      const wb = await watch(a1, 'A1');
      try {
        // A RESTARTED APP RE-LOCKS THE PIN, and everything behind the modal is unreachable - a
        // landing measured through a closed gate reads as "the deep link did nothing".
        const gateA1 = await unlockClient(a1, PORTS.A1, ACCOUNT_OF.A1, { match: 'tauri.localhost' });
        if (gateA1.verdict !== 'unlocked') return { gate: gateA1.verdict, said: gateA1.said };

        // The landing is not instant: the handler navigates, the sidebar loads, and the selection is
        // applied when the salon appears in it. Polled for the SALON being open, which is the
        // product's own statement about where the person is.
        const deadline = Date.now() + 90_000;
        let open = null;
        for (;;) {
          open = await selectedChannel(a1).catch(() => null);
          if (open === salon) break;
          if (Date.now() > deadline) break;
          await sleep(2000);
        }
        const url = await evaluate(a1, 'location.pathname').catch(() => null);
        const seen = await countMessage(a1, marker).catch(() => 0);
        const lines = consoleLines(wb.cx);
        return {
          gate: gateA1.verdict,
          open,
          url,
          seen,
          // The one line that says the native half worked, and the ones around it if it did not.
          handlerSaid: lines.filter((l) => /\[notifNav\] deep link received/.test(l)),
          hooksSaid: lines.filter((l) => /\[hooks\]/.test(l)).slice(0, 12),
          report: await report(wb),
        };
      } finally {
        a1.close();
      }
    })
  : null;

// -- Its own debris goes -------------------------------------------------------------------------
await step('delete the community', async () => {
  if (!workspaceId) return;
  await enterCommunities(w1);
  await openCommunity(w1, community);
  await deleteCommunity(w1, community);
});

const expectations = {
  // The handler ran at all, and it read the target out of the url.
  theDeepLinkReachedTheHandler: (landing?.handlerSaid?.length ?? 0) > 0,
  // The route the target belongs to. A channel that landed on `/chat` is `chatDeepLinkRoute` wrong.
  theAppLandedOnTheCommunitiesRoute: landing?.url === '/communities',
  // Where the person actually is, in the product's own words.
  theSalonIsOpen: landing?.open === salon,
  // And it is really that salon, not an empty pane wearing its name.
  theMessageIsOnScreen: (landing?.seen ?? 0) > 0,
};

const verdict =
  !armed || landing?.gate !== 'unlocked'
    ? 'VACUOUS'
    : failures.length > 0 || Object.values(expectations).some((v) => v !== true)
      ? 'FAIL'
      : 'PASS';

const gated = gate(verdict, { W1: await report(wa), A1: landing?.report ?? null });

record('COMM-18', gated.verdict, {
  ...gated.detail,
  community,
  salon,
  workspaceId,
  channelId,
  link,
  armed,
  // A1's build is named beside its answer: its APK is deliberately not the deployment.
  a1Build: a1Before?.commit ?? null,
  a1BuiltAt: a1Before?.builtAt ?? null,
  a1Gate: landing?.gate ?? null,
  openedChannel: landing?.open ?? null,
  landedOn: landing?.url ?? null,
  markerSeen: landing?.seen ?? null,
  handlerSaid: landing?.handlerSaid ?? null,
  // Recorded whether or not the handler line came: when it did not, these are the only account of
  // how far the chain got.
  hooksSaid: landing?.hooksSaid ?? null,
  ...expectations,
  failures,
});

w1.close();
