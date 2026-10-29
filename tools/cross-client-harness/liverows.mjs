/**
 * LIVE-WEB-2 AND LIVE-STALL-1 - A LIVE BROADCAST FROM THE MI 9T, WATCHED FROM THE WEB (2026-10-27).
 *
 * A1 (the Mi 9T, a member) goes live from the feed composer; the viewer seats see the feed card,
 * play, are counted, and see the end when A1 ends. Runner `archive/liveweb.mjs`; this file is the
 * table, the judges and the narration, all pure.
 *
 * LIVE-STALL-1 IS L-F1's ROW ([live](../../docs/wiki/frontend/modules/live.md), the findings table).
 * The Android recorder hands its 2 s fragments over in PAIRS about every 4 s, and a viewer playing one
 * fixed target buffer behind the edge ran dry before each pair: `stalled at`, then `seek to the live
 * edge (stall)`, every ~4 s. The fix widens the viewer's target buffer on a delivery gap and says so
 * (`a delivery gap of N ms - target buffer now N ms`). So the row watches for a minute and judges the
 * ORDER of each viewer's own lines: a stall BEFORE the first gap is the viewer learning the cadence;
 * one AFTER it is the fix not holding. Every LIVE row is judged that way - LIVE-WEB-2 watches only
 * 6 s, so on a build without the fix it fails on the stalls it always had, which is the finding.
 *
 * A PHONE AS A VIEWER IS OWED ON HARDWARE. A1 is the only bench phone the rig drives, and it is the
 * broadcaster; the iPhone viewer is check Y of `device-verification.md`.
 *
 * ROUNDS, NOT CLOCKS: every wait is a count of {@link ROUND_MS} rounds on a fact.
 */
import { atLevels, stripStamp } from './watch.mjs';

export const ROUND_MS = 500;

/**
 * The rows `archive/liveweb.mjs` plays. `by` broadcasts; `viewers` watch from the feed card for
 * `watchRounds` rounds once playing; `devices` is both, read by `checks.mjs` `ROW_TABLES` so the
 * preflight arms the phone and stamps its build.
 */
export const LIVE_ROWS = {
  'LIVE-WEB-2': { by: 'A1', viewers: ['W2', 'W4'], devices: ['A1', 'W2', 'W4'], watchRounds: 12, what: 'A1 goes live as a member; W2 and W4 see the card, play, are counted; A1 ends and both see the end' },
  'LIVE-STALL-1': { by: 'A1', viewers: ['W2', 'W4'], devices: ['A1', 'W2', 'W4'], watchRounds: 120, what: 'L-F1: A1 broadcasts for a minute to W2 and W4; no viewer stalls after its first delivery gap, and each target buffer it moved to is recorded' },
};

/** Seconds the video must advance over the watch, as a share of the wall time watched. */
export const PLAYED_SHARE = 0.5;

// ── the order of a viewer's own lines (L-F1) ──────────────────────────────────────────────────────

const S = String.raw`[0-9a-f]{8}(?:…|\.\.\.)`;
const GAP = new RegExp(String.raw`^\[LIVE\] viewer ${S}: a delivery gap of (\d+) ms - target buffer now (\d+) ms$`);
// THE SPELLINGS ARE `livePlayer.ts`'s ON MAIN AFTER #2583 (the L-F1 fix), read from the source: a
// pattern that matched no real line would make this judge pass on every viewer. `stallsOf` also
// keeps every viewer line that SAYS stall and matches neither, and such a line fails the row.
const STALL = new RegExp(String.raw`^\[LIVE\] viewer ${S} stalled at [\d.]+(?: \(target \d+(?:\.\d+)? ms\))?$`);
// `\.\d+`: the stall line prints the target UNROUNDED (`livePlayer.ts`, `${this.policy.targetMs}`),
// read as `4634.20000000298 ms` on LIVE-STALL-1 (1.5.1-alpha.1) - the gap and seek lines round it.
const STALL_SEEK = new RegExp(String.raw`^\[LIVE\] viewer ${S}: seek to the live edge \(stall\) at [\d.]+(?:, \d+ ms behind)?$`);
const NOT_A_STALL = new RegExp(String.raw`^\[LIVE\] viewer ${S}: waiting while seeking at [\d.]+ - not a stall$`);
const SAYS_STALL = /^\[LIVE\] viewer .*stall/;
const JOINED = new RegExp(String.raw`^\[LIVE\] viewer joined ${S} at segment \d+$`);
// THE ENDED LIVE'S ANSWER, as the player classifies it (`liveFailureOutcome`), and the stop it must cause.
const END_ANSWER = /^\[LIVE\] Live manifest: (404 LIVE_NOT_FOUND -> not-found|410 LIVE_ENDED -> ended \([a-z_]+\))$/;
const STOPPED_ON_END = new RegExp(String.raw`^\[LIVE\] viewer ${S}: stopped on ended \((404 not-found|410 ended)\)$`);

/** A console text as the narration compares it: no `level:` prefix, no stamps. */
const sentence = (line) => stripStamp(String(line).replace(/^(?:log|info|debug|verbose|warning|warn|error|assert):?\s+/, ''));

/**
 * What one viewer's console says about its stalls, in order: the first delivery gap, every target
 * buffer it moved to, and the stalls and stall seeks before and after that first gap. And the
 * ended live's manifest answers (`endAnswers`) with how many were NOT followed at once by the stop
 * they must cause (`strayEndAnswers`) - what bounds `liveRefusals`, which cannot see order.
 *
 * @param {string[]} lines the viewer's console texts, oldest first
 */
export function stallsOf(lines) {
  const out = { joined: false, gaps: [], targets: [], stallsBefore: 0, stallsAfter: 0, stallSeeksBefore: 0, stallSeeksAfter: 0, unread: [], endAnswers: 0, strayEndAnswers: 0 };
  let answered = false;
  /** Each stall not yet resolved by a seek, oldest first: true when it came after the first gap. */
  const unresolved = [];
  for (const raw of lines) {
    const s = sentence(raw);
    if (answered && !STOPPED_ON_END.test(s)) out.strayEndAnswers++;
    answered = END_ANSWER.test(s);
    if (answered) {
      out.endAnswers++;
      continue;
    }
    if (JOINED.test(s)) out.joined = true;
    const g = GAP.exec(s);
    if (g) {
      out.gaps.push(Number(g[1]));
      out.targets.push(Number(g[2]));
      continue;
    }
    const after = out.gaps.length > 0;
    if (STALL.test(s)) {
      out[after ? 'stallsAfter' : 'stallsBefore']++;
      unresolved.push(after);
    } else if (STALL_SEEK.test(s)) {
      // A STALL SEEK BELONGS TO THE STALL IT RESOLVES, not to where its line falls: the player names
      // the gap and then seeks in the same tick, so the seek out of a stall taken BEFORE the first gap
      // is printed just after it (LIVE-WEB-2 and LIVE-STALL-1 on 1.5.1-alpha.1, W2). A seek with no
      // stall left open is counted where it falls. A pre-gap stall left open can absorb ONE later seek,
      // and that is safe: the player emits a stall seek only out of a stall, and any stall LINE after
      // the gap is counted after on its own and still fails the row.
      const of = unresolved.length ? unresolved.shift() : after;
      out[of ? 'stallSeeksAfter' : 'stallSeeksBefore']++;
    } else if (SAYS_STALL.test(s) && !NOT_A_STALL.test(s)) out.unread.push(s);
  }
  if (answered) out.strayEndAnswers++; // an end answer as the very last line stopped nothing
  return out;
}

/**
 * One viewer's facts: it joined (else every stall count below is vacuous); no stall line it cannot
 * read; no stall after its first gap and none without a gap (L-F1); and at most ONE ended-live answer,
 * followed at once by the stop it causes - the one 404 or 410 `liveRefusals` forgives.
 */
export function stallFacts(viewer, st) {
  return [
    [st.joined, `${viewer} wrote no "viewer joined" line - nothing below was read from a playing viewer`],
    [st.endAnswers <= 1 && st.strayEndAnswers === 0, `${viewer} read the ended live's answer ${st.endAnswers} time(s), ${st.strayEndAnswers} of them not followed by its stop`],
    [st.unread.length === 0, `${viewer} wrote ${st.unread.length} stall line(s) this judge cannot read - a spelling moved: ${st.unread.slice(0, 2).join(' | ')}`],
    [st.stallsAfter === 0 && st.stallSeeksAfter === 0, `${viewer} stalled ${st.stallsAfter} time(s) and seeked ${st.stallSeeksAfter} time(s) after its first delivery gap (targets ${st.targets.join(',') || 'none'} ms)`],
    [st.gaps.length > 0 || (st.stallsBefore === 0 && st.stallSeeksBefore === 0), `${viewer} stalled ${st.stallsBefore} time(s) and never named a delivery gap - the target buffer never moved`],
  ];
}

/** Seconds a viewer's video advanced between two reads of it, or null. */
const advancedBy = (p) => (p?.a && p?.b ? p.b.t - p.a.t : null);

/**
 * One row's verdict from what it measured: `{ verdict, failures }`.
 *
 * `m`: `{ onAir, card, join, play, watchedMs, count, ended, seenEnded, stalls }` - rounds are `null`
 * when the fact never happened within its bound; `play[v]` holds the video read at the start and the
 * end of the watch; `stalls[v]` is {@link stallsOf} of the viewer's lines.
 *
 * @param {string} row a `LIVE_ROWS` id
 */
export function liveOwn(row, m) {
  const { by, viewers } = LIVE_ROWS[row];
  const facts = [
    [m.onAir !== null, `${by} never reached on air`],
    ...viewers.map((v) => [m.card[v] !== null, `${v} never saw the feed card`]),
    ...viewers.map((v) => [m.join[v] !== null, `${v}'s viewer never reached playing`]),
    ...viewers.map((v) => {
      const s = advancedBy(m.play[v]);
      const need = (PLAYED_SHARE * m.watchedMs) / 1000;
      return [s !== null && s >= need && m.play[v].b.w > 0 && !m.play[v].b.paused, `${v}'s video advanced ${s?.toFixed(2) ?? 'nothing'} s in ${(m.watchedMs / 1000).toFixed(1)} s watched (at least ${need.toFixed(1)}), or is paused or has no picture`];
    }),
    [m.count !== null, `${by}'s viewer count never reached the viewers playing`],
    [m.ended !== null, `${by} never reached ended`],
    ...viewers.map((v) => [m.seenEnded[v] !== null, `${v} never saw the live end`]),
    ...viewers.flatMap((v) => stallFacts(v, m.stalls[v])),
  ];
  const failures = facts.filter(([ok]) => !ok).map(([, why]) => why);
  return { verdict: failures.length ? 'FAIL' : 'PASS', failures };
}

// ── narration ─────────────────────────────────────────────────────────────────────────────────────
//
// EVERY LINE BELOW IS THE LIVE PATH NARRATING ITSELF, read on the scratch readings of 2026-10-26
// (LIVE-WEB-2 and -3 on `1.4.1-alpha.6`). Forgiven only in a LIVE row, only on the seat whose ROLE
// prints it, and only at the level the app writes it - the same words at `warn` or `error` stay dirt.
// The stall lines ARE forgiven here: whether they are acceptable is {@link stallFacts}' to judge, by
// their order, and a narration rule cannot see order.

const D = ['debug'];
const L = ['log'];
const N = String.raw`\d+`;
const F = String.raw`[\d.]+`;
const at = (levels, s) => atLevels(levels, new RegExp(`^${s}$`));

/** The feed every seat of the row opens: the broadcaster to compose, a viewer to find the card. */
const FEED = [
  at(D, String.raw`\[POSTS\] stored first page drawn: ${N} posts read in ${N} ms`),
  at(D, String.raw`\[progressive-mount\] all ${N} mounted`),
  at(D, String.raw`\[LIVE\] list`),
  at(D, String.raw`\[LIVE\] feed card: ${N} open live\(s\)`),
];

/** The broadcaster, from the feed's composer and its live chip to the camera given back. */
const BROADCASTER = [
  ...FEED,
  // THE PHONE'S FEED reserves its left edge for the tab swipe while the page is on screen; A1 opens the
  // feed by a tap to compose (read on LIVE-WEB-2, 2026-10-27).
  at(D, String.raw`\[GESTURE\] left-edge exclusion (over ${N}\.\.${N} px|cleared)`),
  at(D, String.raw`\[POST_COMPOSER\] live screen opened`),
  at(D, String.raw`\[live-overlay\] open`),
  at(D, String.raw`\[theme\] native bars (held at dark|released)`),
  at(D, String.raw`\[LIVE\] (limits|rules|start)`),
  at(D, String.raw`\[LIVE-BROADCAST\] screen for the member, recordable true`),
  at(D, String.raw`\[LIVE-BROADCAST\] rules v${N}, accepted v${N}`),
  at(D, String.raw`\[LIVE-BATTERY\] ${N} %(, charging)?`),
  at(D, String.raw`\[LIVE-CAM\] opening user`),
  at(D, String.raw`\[LIVE-CAM\] opened user: ${N}x${N} @ ${N}`),
  at(L, String.raw`\[LIVE-BROADCAST\] starting`),
  at(L, String.raw`\[LIVE\] started ${S}`),
  at(D, String.raw`\[LIVE-PIPE\] generation ${N} begins at \+${N} ms`),
  at(D, String.raw`\[LIVE-REC\] recording video/mp4;codecs=[\w.,]+`),
  at(L, String.raw`\[LIVE-BROADCAST\] on air \(recorder ${N}\)`),
  at(D, String.raw`\[LIVE_CHAT\] broadcaster chat (opened|loop) on ${S}`),
  at(D, String.raw`\[LiveChat\] \{"op":"key","liveId":"${S}"\}`),
  at(D, String.raw`\[LiveChat\] \{"op":"stop","liveId":"${S}","lines":${N}\}`),
  at(D, String.raw`\[LIVE-WAKE\] screen (held on|released)`),
  at(D, String.raw`\[LIVE-PIPE\] generation ${N}: init ${N} B, video track ${N}`),
  at(D, String.raw`\[LiveCrypto\] \{"op":"seal","index":${N},"plainBytes":${N}\}`),
  at(D, String.raw`\[LIVE\] segment ${N} of ${S}: ${N} B`),
  at(D, String.raw`\[LIVE-PIPE\] segment ${N} queued`),
  // The pipeline's periodic summary (every 15 segments, read on LIVE-STALL-1, 2026-10-27). `not on
  // keyframe 0, dropped 0` and ONE generation open ARE THE ASSERTION; the two-fragment count is L-F1's
  // cause (paired seals), recorded rather than judged here - the viewer's lines judge its effect.
  at(L, String.raw`\[LIVE-PIPE\] summary: ${N} segments, ${F} MB, seal ${F} ms avg, two-fragment chunks ${N}, not on keyframe 0, dropped 0, generations open 1`),
  at(D, String.raw`\[LIVE-SCREEN\] end asked`),
  at(L, String.raw`\[LIVE-BROADCAST\] ending ${S}`),
  at(D, String.raw`\[LIVE-BROADCAST\] recording paused: (the live is ending|the screen is closing)`),
  at(D, String.raw`\[LIVE-REC\] stopped, last chunk handed over`),
  at(D, String.raw`\[LIVE-PIPE\] generation ${N} ended clean`),
  at(D, String.raw`\[camera\] released`),
  at(D, String.raw`\[LIVE-BROADCAST\] camera given back; ${N} segments to send`),
  at(D, String.raw`\[LIVE\] end ${S}`),
  at(L, String.raw`\[LIVE\] ${S} ended \(broadcaster\)`),
  // `0 dropped, 0 off a keyframe` IS THE ASSERTION: a live that dropped a segment stays dirt.
  at(L, String.raw`\[LIVE-BROADCAST\] ${S} ended \(broadcaster\) after ${N} s: ${N} segments, 0 dropped, 0 off a keyframe`),
  // A live screen an earlier attempt left open, closed by the runner before it starts.
  at(D, String.raw`\[LIVE-SCREEN\] close in (preview|ended)`),
  at(D, String.raw`\[LIVE-BROADCAST\] dispose in (preview|ended)`),
];

/**
 * WHAT THE PHONE SAYS WHILE IT TAPS ITS WAY TO THE COMPOSER, and only the phone, only as the
 * broadcaster (read on LIVE-WEB-2, A1 on the #2652 head 582975676, 2026-10-28). A1 reaches the feed by a
 * TAP, not a page load, so these are decisions of an in-app navigation, not of a boot: the boot
 * narration (`PAGE_BOOT_NARRATION`) is NOT forgiven here, and a phone that reloads mid-row stays dirt.
 *
 * - `[AvatarPresence] <missing> of <asked> have no photo - not requested`: the feed asked the server which authors
 *   have a photo and DECIDED not to fetch the rest (#1840). Only that answered shape is forgiven; every
 *   fallback (`HTTP <status>`, `could not say`, `could not ask` - each ends "each avatar is asked") is
 *   the question going unanswered, and stays dirt.
 * - `[NameMirror] mirrored N name(s), 0 removal(s), N held`: the names this navigation resolved were
 *   written to the native file the push path reads (WP-MENTION-NAME, #2047). Only a mobile Tauri build
 *   prints it, so a web seat saying it is a finding. A REMOVAL is an account the server just called
 *   deleted, which nothing in a live row deletes, so `1 removal(s)` stays dirt; so do the dropped-batch
 *   line and the `[NAME_MIRROR] store failed` warn.
 */
const PHONE_BROADCASTER = [
  at(D, String.raw`\[AvatarPresence\] ${N} of ${N} have no photo - not requested`),
  at(D, String.raw`\[NameMirror\] mirrored ${N} name\(s\), 0 removal\(s\), ${N} held`),
];

/** A native app seat (`A1` Android, `I1` iOS) - the only one that prints the NameMirror line. */
const isAppSeat = (seat) => /^[AI]\d+$/.test(seat);

/** A viewer, from the feed to the end it was told about. */
const VIEWER = [
  ...FEED,
  at(D, String.raw`\[LIVE\] limits`),
  at(D, String.raw`\[POSTS\] live ${S} opened from the feed card`),
  at(D, String.raw`\[VIDEO\] viewer opens with the app's sound`),
  at(D, String.raw`\[LIVE\] viewer (opened on|start) ${S}`),
  at(D, String.raw`\[LIVE\] viewer source open \((Managed)?MediaSource, video/mp4; codecs="[\w.,]+"\)`),
  at(D, String.raw`\[LIVE\] open ${S}`),
  at(D, String.raw`\[LiveChat\] \{"op":"key","liveId":"${S}"\}`),
  at(D, String.raw`\[LiveCrypto\] \{"op":"open","index":${N},"sealedBytes":${N}\}`),
  at(D, String.raw`\[LIVE\] viewer ${S}: no segment yet, waiting`),
  // `join` and `stall` only: `catch-up`, `drift` and `time gap` are a viewer behind or a broadcaster
  // re-acquiring its camera, none of them the steady path, so each stays dirt until a reading explains it.
  at(D, String.raw`\[LIVE\] viewer ${S}: seek to the live edge \((join|stall)\) at ${F}, ${N} ms behind`),
  at(L, String.raw`\[LIVE\] viewer joined ${S} at segment ${N}`),
  at(D, String.raw`\[LIVE\] viewer ${S} -> (playing|ended)`),
  at(D, String.raw`\[LIVE\] viewer ${S} stalled at ${F} \(target ${N} ms\)`),
  at(D, String.raw`\[LIVE\] viewer ${S}: waiting while seeking at ${F} - not a stall`),
  at(D, String.raw`\[LIVE\] viewer ${S}: a delivery gap of ${N} ms - target buffer now ${N} ms`),
  // One per delivery: what it did to the buffer, so a reading separates uneven media from drift.
  // The gap is `-` after an outage the policy did not measure; the end is always a number here,
  // since the join buffered media before any poll delivers.
  at(D, String.raw`\[LIVE\] viewer ${S}: delivery of ${N} segment\(s\) \(${N}-${N}\), gap (?:${N}|-) ms: end ${F} -> ${F}, at ${F} -> ${F}, ahead ${F} -> ${F} s`),
  at(L, String.raw`\[LIVE\] viewer ${S} \(ended\): ${N} segments played, ${N} skipped, ${N} seeks, at ${N}`),
  at(D, String.raw`\[LIVE\] viewer ${S}: segment downloads of the ending run cancelled`),
  at(D, String.raw`\[LIVE\] viewer ${S}: the chat heard the live is over`),
];

/**
 * The narration a seat is given in a LIVE row: by row, by seat, by role - and nothing else.
 *
 * @param {string} row a `LIVE_ROWS` id
 * @param {string} seat
 * @param {Record<string, {by: string, viewers: string[]}>} [rows] the table; the self-test passes one
 *   with a WEB broadcaster, a shape no live row has yet, to prove the app-seat scope holds
 */
export function liveNarration(row, seat, rows = LIVE_ROWS) {
  const spec = rows[row];
  if (!spec) return [];
  if (seat === spec.by) return isAppSeat(seat) ? [...BROADCASTER, ...PHONE_BROADCASTER] : BROADCASTER;
  if (spec.viewers.includes(seat)) return VIEWER;
  return [];
}

/**
 * THE ENDED LIVE'S MANIFEST ANSWERS 410 `LIVE_ENDED` until the end's purge has run, and 404
 * `LIVE_NOT_FOUND` after it (both on LIVE-WEB-2, 2026-10-27: W4 polled before the purge, W2 after it).
 * That is how a viewer whose chat did not hear the end first learns it (`stopped on ended`): a status,
 * an answer, once. Only on a viewer seat.
 *
 * THIS FORGIVENESS CANNOT SEE TIME: the rendered request line carries none, so it covers the whole row
 * on a viewer. What bounds it is `stallFacts`, over the viewer's own lines in order: at most one such
 * answer, followed at once by `stopped on ended`. A 404 or 410 mid-live would stop the viewer early
 * (its video stops advancing) or come without that stop, and either fails the row. A SEGMENT 404 (`segment N is gone - skipped`) is NOT forgiven: it is the purge at the
 * end racing a viewer's download, a finding.
 *
 * @param {string} row a `LIVE_ROWS` id
 * @param {string} seat
 */
export function liveRefusals(row, seat) {
  const spec = LIVE_ROWS[row];
  if (!spec?.viewers.includes(seat)) return [];
  return [{ path: /^\/api\/lives\/[0-9a-f-]{36}\/manifest\?/, status: [404, 410] }];
}
