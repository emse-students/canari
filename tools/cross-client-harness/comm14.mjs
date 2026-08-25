/**
 * COMM-14: the three channel notification levels, decided by the SERVER, observed on a real phone.
 *
 *   node comm14.mjs
 *
 * WHAT THE ROW ASKS is not what the settings panel shows. `all` / `mentions` / `none` is a per
 * (member, salon) column that only the server reads: it is applied in `notifyChannelRecipients`,
 * after the audience is computed and before a single push leaves the building. A check that clicked
 * the three buttons and read them back would be testing a `PATCH` and a re-render - the enforcement
 * is somewhere no browser can see.
 *
 * TWO OBSERVERS, BECAUSE ONE OF THEM CANNOT SAY WHY.
 *
 *  - The SERVER's own line, `[CHANNEL_PUSH] channel=<id> message=<id> recipients=N`, is the decision
 *    itself, and it is emitted only when the filtered list is non-empty. Its absence for a message
 *    that definitely reached the server is the assertion `none` and `mentions` are owed.
 *  - The PHONE's notification tray is the fact that the decision reaches a person. A row that only
 *    read the server would pass on a platform where no push has ever been delivered - which is
 *    precisely the state this row's `+push` requirement exists to refuse. A capability is unproven
 *    until a check using it produces a result it could not have produced by accident.
 *
 * THE ORDER IS THE INSTRUMENT. The tray is append-only within a run and this harness will not clear
 * it - `cmd notification` is not on every Android, and a setup step that can silently no-op is worse
 * than one that is not needed. So the NEGATIVE cases run FIRST, while no notification for this salon
 * can possibly exist: any tray entry naming it is then a violation, with no before-set to diff and
 * no way for a stale banner to pass for a new one. The positive cases run last, where an entry
 * APPEARING is the claim.
 *
 * A1 IS W1's SECOND DEVICE, so the level under test is W1's own and the sender must be W2:
 * `notifyChannelRecipients` skips the sender, and a check whose phone account sent the message would
 * measure that skip four times over and call it a filter.
 *
 * THE PHONE IS BACKGROUNDED, on purpose. A foregrounded app consumes the data push and draws no
 * banner, so a tray read against a foreground phone answers "no notification" for every level and
 * the four cases become indistinguishable.
 *
 * THE BODY IS RECORDED, NEVER ASSERTED. The user's observation of 2026-08-20 - a GENERIC body on the
 * phone - is what this row was told to look at, and it is a question about the APK's own decrypt
 * path rather than about the filter. The title (`<Communaute> - #<salon>`) is what identifies the
 * notification; whether the body carries the marker is written down beside it.
 *
 * IT BUILDS A SALON IN THE CAMPAIGN VENUE and deletes it. The community is shared because the level
 * is per SALON: a fresh community would cost an invite and an accept to observe the same column.
 */
import { client, fireComposer, mentionInComposer, realClick, send } from './chat.mjs';
import {
  channelRow,
  createChannel,
  deleteChannel,
  enterCommunities,
  inPanel,
  openChannelSettings,
  openCommunity,
  selectedChannel,
  setChannelNotifLevel,
} from './comm.mjs';
import { channelIdOf, channelNotifLevelOf, userIdOf, workspaceIdOf } from './grainedb.mjs';
import { OWNER_NAME, PORTS, VENUE } from './names.mjs';
import { home as phoneHome, notifications, pid as phonePid, wake } from './phone.mjs';
import { clientBuild, mark, record } from './results.mjs';
import { srvLines } from './srvlog.mjs';
import { consoleLines, gate, report, watch } from './watch.mjs';

const run = mark('COMM14');
const salon = `c14-${run.toLowerCase()}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const w1 = await client(PORTS.W1);
const w2 = await client(PORTS.W2);
const wa = await watch(w1, 'W1');
const wb = await watch(w2, 'W2');

const failures = [];
const step = async (name, fn) => {
  try {
    return await fn();
  } catch (e) {
    failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
};

/** The server-log window: the whole run so far, so no case can fall outside it. */
const startedAt = Date.now();
const since = () => `${Math.ceil((Date.now() - startedAt) / 1000) + 60}s`;

/**
 * Every `[CHANNEL_PUSH]` decision line for this salon so far, as `{ messageId, recipients }`.
 *
 * READ AS A SET AND DIFFED, never counted: production is shared and the run is minutes long, so a
 * count would be answered by any traffic at all. The salon id is this run's own, so the filter is
 * exact and the message id is what separates one case from the next.
 */
function pushDecisions(channelId) {
  const re = new RegExp(
    `\\[CHANNEL_PUSH\\] channel=${channelId} message=([0-9a-f-]+) recipients=(\\d+)`
  );
  return srvLines('social-service', since())
    .map((l) => l.match(re))
    .filter(Boolean)
    .map((m) => ({ messageId: m[1], recipients: Number(m[2]) }));
}

/** The tray entries whose title names this salon - the push title is `<Communaute> - #<salon>`. */
const trayForSalon = () => notifications().filter((n) => n.full.includes(`#${salon}`));

/** Opens the run's salon, entering its community first - both gestures are idempotent. */
async function openSalonOn(cx) {
  await enterCommunities(cx);
  await openCommunity(cx, VENUE.community);
  for (let i = 0; i < 30; i += 1) {
    if ((await channelRow(cx, salon)).present) break;
    await sleep(1500);
  }
  await realClick(cx, `[aria-label*=${JSON.stringify(salon)}]`);
  const open = await selectedChannel(cx);
  if (open !== salon) throw new Error(`wrong salon open: ${JSON.stringify(open)}`);
}

/**
 * One case: set W1's level, have W2 send, and report what the server and the phone each did.
 *
 * THE STORED LEVEL IS READ FROM THE DATABASE, not from the panel that was just clicked. The column
 * is what the filter consults, and `notifLevels` absent DEFAULTS to `all` - so a click that silently
 * failed and a column that says `all` are the same screen and different facts.
 */
async function caseOf(name, { level, text, mention, channelId, workspaceId, ownerId }) {
  const before = pushDecisions(channelId);
  const trayBefore = trayForSalon().length;

  const levelStored = await step(`${name}: set the level to ${level}`, async () => {
    await openSalonOn(w1);
    await inPanel(w1, openChannelSettings, () => setChannelNotifLevel(w1, level));
    return channelNotifLevelOf(workspaceId, channelId, ownerId);
  });

  const sent = await step(`${name}: W2 sends`, async () => {
    await openSalonOn(w2);
    if (mention) {
      // The chip carries the id the sender will put in `mentionedUserIds`; the text follows it so
      // the message is identifiable in the transcript as well as in the tray.
      const mentioned = await mentionInComposer(w2, mention);
      await w2.send('Input.insertText', { text: ` ${text}` });
      await fireComposer(w2);
      return mentioned;
    }
    await send(w2, text);
    return null;
  });

  // THE DECISION IS TAKEN BEFORE THE SEND IS ANSWERED; this window is for the READ, which crosses
  // ssh and docker. A negative case given less of it than a positive one would be measuring the
  // wait rather than the filter, so every case gets the same.
  await sleep(20_000);

  const fresh = pushDecisions(channelId).filter(
    (d) => !before.some((b) => b.messageId === d.messageId)
  );
  const tray = trayForSalon();
  return {
    name,
    levelAsked: level,
    levelStored,
    text,
    mentionedId: sent ? String(sent).slice(0, 8) : null,
    pushed: fresh.length > 0,
    recipients: fresh.map((d) => d.recipients),
    trayBefore,
    trayAfter: tray.length,
    trayTitles: tray.map((n) => n.title),
    trayBodies: tray.map((n) => n.body),
  };
}

// -- Arming --------------------------------------------------------------------------------------
// THE PHONE HAS TO BE THERE, AWAKE AND IN THE BACKGROUND, and none of the three is this check's to
// assume. A phone that is off leaves an empty tray for every case, which reads as three perfect
// negatives and one unexplained positive - the shape of a green run that measured nothing.
const ownerId = await step('resolve the owner user id', () => userIdOf(OWNER_NAME));
const workspaceId = await step('read the community id', () => workspaceIdOf(VENUE.community));
const phoneUp = await step('is the phone running', () => phonePid());
const a1 = await step('read the build the phone is running', async () => {
  const cx = await client(PORTS.A1);
  try {
    return await clientBuild(cx);
  } finally {
    cx.close();
  }
});
await step('background the phone', async () => {
  wake();
  phoneHome();
  await sleep(2000);
});

const armed = !!ownerId && !!workspaceId && !!phoneUp;

// -- The venue: one PUBLIC salon, so the peer can post in it without a grant ----------------------
const channelId = armed
  ? await step('create the salon on W1', async () => {
      await enterCommunities(w1);
      await openCommunity(w1, VENUE.community);
      await createChannel(w1, salon, { visibility: 'public' });
      return channelIdOf(workspaceId, salon);
    })
  : null;

// -- The four cases, negatives first so the tray is empty for this salon --------------------------
const cases = [];
for (const spec of channelId
  ? [
      { name: 'none', level: 'none', text: `${run}-none` },
      { name: 'mentions, unmentioned', level: 'mentions', text: `${run}-plain` },
      {
        name: 'mentions, mentioned',
        level: 'mentions',
        text: `${run}-tagged`,
        mention: OWNER_NAME.split(' ')[0],
      },
      { name: 'all', level: 'all', text: `${run}-all` },
    ]
  : []) {
  // THE WHOLE CASE IS A STEP. The tray read goes over adb and the server read over ssh, and either
  // can fail transiently - a throw here used to kill the runner and take the three cases that had
  // already run with it. A case that could not be taken is recorded as one that failed, which the
  // assertions below then read as FAIL rather than as a passing absence.
  cases.push(
    (await step(spec.name, () => caseOf(spec.name, { ...spec, channelId, workspaceId, ownerId }))) ?? {
      name: spec.name,
      levelAsked: spec.level,
      levelStored: null,
      unmeasured: true,
    }
  );
}

const byName = Object.fromEntries(cases.map((c) => [c.name, c]));

// -- The assertions -------------------------------------------------------------------------------
// EACH NAMES BOTH OBSERVERS. The server line is the decision; the tray is that the decision reaches
// a person. A level that passed the first and failed the second is a different defect from one that
// failed both, and a single boolean could not say which.
// AN EXPECTATION NOBODY MEASURED IS `null`, NEVER `false`. Without the venue no case runs at all,
// and six `false` lines then describe six failures where there was exactly ONE - a reader counting
// them believes the notification filter is broken in six places. `measured` is the discriminator,
// and it is the venue: the four cases are built from `channelId` or from nothing.
const measured = cases.length > 0;
const only = (v) => (measured ? v : null);

const levelsStored = only(cases.every((c) => c.levelStored === c.levelAsked));
const noneIsSilent = only(byName.none?.pushed === false && byName.none?.trayAfter === 0);
const mentionsSkipsTheUnmentioned = only(
  byName['mentions, unmentioned']?.pushed === false &&
    byName['mentions, unmentioned']?.trayAfter === 0
);
const mentionsDelivers = only(
  byName['mentions, mentioned']?.pushed === true &&
    (byName['mentions, mentioned']?.recipients ?? []).every((n) => n >= 1)
);
const allDelivers = only(
  byName.all?.pushed === true && (byName.all?.recipients ?? []).every((n) => n >= 1)
);
// THE CAPABILITY ITSELF. Without one real notification in the tray the four cases above are a story
// about a log line, and three of them read identically on a phone that has never received a push.
const thePhoneWasReallyPushed = only((byName['mentions, mentioned']?.trayAfter ?? 0) > 0);

// `channelId` IS NOT PART OF `armed`, deliberately. Creating a public salon is product surface, so
// a venue that could not be built is a FAILING check and not an unarmed one - calling it VACUOUS
// would hide a broken create path behind "the phone was not ready". `armed` stays what it says: the
// three facts this check cannot itself establish.
const verdict = !armed
  ? 'VACUOUS'
  : failures.length > 0 ||
      !channelId ||
      levelsStored !== true ||
      noneIsSilent !== true ||
      mentionsSkipsTheUnmentioned !== true ||
      mentionsDelivers !== true ||
      allDelivers !== true ||
      thePhoneWasReallyPushed !== true
    ? 'FAIL'
    : 'PASS';

const gated = gate(verdict, { W1: await report(wa), W2: await report(wb) });

record('COMM-14', gated.verdict, {
  ...gated.detail,
  community: VENUE.community,
  salon,
  channelId,
  owner: ownerId ? ownerId.slice(0, 8) : null,
  armed,
  venueBuilt: !!channelId,
  casesMeasured: measured,
  // THE THREE HALVES OF `armed`, EACH NAMED. `armed: false` beside `failures: []` is what this row
  // recorded on 2026-08-25, and it accounts for nothing: `workspaceIdOf` answers null for a venue
  // that is not there rather than throwing, so the step that asked had nothing to report and the
  // conjunction had nowhere to say which of its three terms was the empty one. The shared venue had
  // been deleted; the row could only say it was unarmed. A conjunction that is recorded as one
  // boolean is an instrument reporting its own verdict instead of its reading.
  ownerResolved: !!ownerId,
  venueOnTheServer: !!workspaceId,
  phoneRunning: !!phoneUp,
  // WHICH BUILD THE PHONE READ. The filter is server-side, so a stale APK does not invalidate the
  // four cases - but it is exactly what the body observation below is about, and a reader needs it.
  a1Build: a1?.commit ?? null,
  a1BuiltAt: a1?.builtAt ?? null,
  cases,
  levelsStored,
  noneIsSilent,
  mentionsSkipsTheUnmentioned,
  mentionsDelivers,
  allDelivers,
  thePhoneWasReallyPushed,
  // THE USER'S OBSERVATION OF 2026-08-20, recorded and not asserted: a body that does not carry the
  // message is a question about the APK's decrypt path, not about the filter this row measures.
  bodiesCarryTheMarker: cases
    .filter((c) => c.pushed)
    .map((c) => ({
      case: c.name,
      bodies: c.trayBodies,
      carriesMarker: c.trayBodies.some((b) => b.includes(c.text)),
    })),
  failures,
});

// -- Its own debris goes --------------------------------------------------------------------------
await step('delete the salon', async () => {
  if (!channelId) return;
  await openSalonOn(w1);
  await deleteChannel(w1);
});

console.log(`\n===== W1: ${consoleLines(wa.cx).length} console lines =====`);
for (const l of consoleLines(wa.cx)) console.log(`  ${l}`);
console.log(`\n===== W2: ${consoleLines(wb.cx).length} console lines =====`);
for (const l of consoleLines(wb.cx)) console.log(`  ${l}`);

w1.close();
w2.close();
