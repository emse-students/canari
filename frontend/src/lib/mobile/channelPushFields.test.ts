import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Channel push payload contract guardrail.
 *
 * One writer, three readers, and nothing between them:
 *   - writer:  `ChannelService.notifyChannelRecipients` (social-service)
 *   - readers: `handleChannelMessage` in the Kotlin FCM service, in the iOS NSE, and in the
 *              app-alive `canari_push.mm`
 *
 * Nothing else can catch drift here. The native halves are verified by COMPILING, which says
 * nothing about which keys they read, and the payload never passes through TypeScript at all. The
 * cost of having no guardrail was measured on 2026-08-15: `workspaceId`, `messageId` and
 * `createdAt` had drifted into being sent to every device and read by none, and `mentioned` - the
 * one field that costs a user something, since it is what puts an `@` in a salon on the mentions
 * notification channel - was computed per recipient and read by nobody either.
 *
 * So the contract is pinned in both directions: every key the server sends is read by all three
 * clients, and every key a client reads is still sent.
 */
const here = dirname(fileURLToPath(import.meta.url));

const CHANNEL_SERVICE_TS = resolve(
  here,
  '../../../../apps/social-service/src/channels/channel.service.ts'
);
const CANARI_FIREBASE_SERVICE_KT = resolve(
  here,
  '../../../src-tauri/gen/android/app/src/main/java/fr/emse/canari/CanariFirebaseMessagingService.kt'
);
const NOTIF_SERVICE_SWIFT = resolve(
  here,
  '../../../src-tauri/gen/apple/canari_NSE/NotificationService.swift'
);
const CANARI_PUSH_MM = resolve(here, '../../../src-tauri/gen/apple/Sources/canari/canari_push.mm');
const PUSH_PAYLOAD_TS = resolve(
  here,
  '../../../../apps/chat-delivery-service/src/services/push-payload.ts'
);

/** Unique, sorted capture group 1 of every match of `regex` in `source`. */
function extractKeys(source: string, regex: RegExp): string[] {
  const keys = new Set<string>();
  for (const match of source.matchAll(regex)) keys.add(match[1]);
  return [...keys].sort();
}

/**
 * Slices out a single function body, so one handler's keys are never confused with the other
 * payloads the same file handles (MLS message, reaction, call, read receipt).
 */
function functionBody(source: string, startPattern: RegExp, endPattern: RegExp): string {
  const start = source.search(startPattern);
  if (start < 0) throw new Error(`function start not found: ${startPattern}`);
  const rest = source.slice(start);
  const end = rest.search(endPattern);
  if (end < 0) throw new Error(`function end not found: ${endPattern}`);
  return rest.slice(0, end);
}

describe('channel push payload contract (social-service writer vs the three native readers)', () => {
  const serviceSource = readFileSync(CHANNEL_SERVICE_TS, 'utf8');
  const kotlinSource = readFileSync(CANARI_FIREBASE_SERVICE_KT, 'utf8');
  const swiftSource = readFileSync(NOTIF_SERVICE_SWIFT, 'utf8');
  const objcSource = readFileSync(CANARI_PUSH_MM, 'utf8');

  const fanOutBody = functionBody(
    serviceSource,
    /private async notifyChannelRecipients\(/,
    /\n {2}\/\*\*\n {3}\* Records that/
  );
  const kotlinHandler = functionBody(
    kotlinSource,
    /private fun handleChannelMessage\(/,
    /\n {4}\/\*\* Looks up the raw epoch key/
  );
  const swiftHandler = functionBody(
    swiftSource,
    /private func handleChannelMessage\(/,
    /\n {2}\/\/\/ Looks up the raw base64 epoch key/
  );
  const objcHandler = functionBody(
    objcSource,
    /static void CanariHandleChannelMessage\(/,
    /\nstatic void CanariHandleFcmData\(/
  );

  /**
   * `type` is the dispatcher's discriminator, read before any of the three handlers is entered,
   * so it is the one sent key that is deliberately not looked for inside a handler body.
   */
  const DISPATCH_KEY = 'type';

  const literal = functionBody(fanOutBody, /const data: Record<string, string> = \{/, /\n {4}\};/);
  // `[:,]` so a shorthand property (`workspaceName,`) counts as a sent key exactly like an explicit
  // one - the wire cannot tell the two apart, and neither may this test.
  const sentKeys = extractKeys(literal, /^\s{6}(\w+)[:,]/gm);

  it('the fan-out sends exactly the keys a client reads, and no more', () => {
    // Spelled out rather than derived: a field added here without a reader is the defect this
    // whole test exists for, and it should fail on the line that adds it.
    expect(sentKeys).toEqual([
      'channelId',
      'channelName',
      'ciphertext',
      'keyVersion',
      'nonce',
      'senderId',
      'type',
      'workspaceName',
    ]);
    // `mentioned` is not in the shared literal: it is computed per recipient and spread in at the
    // send, which is the whole point - it is the only field whose value differs between recipients.
    expect(fanOutBody).toMatch(/mentioned:\s*mentioned\.has\(/);
  });

  it('every key the server sends is read by all three native handlers', () => {
    for (const key of [...sentKeys.filter((k) => k !== DISPATCH_KEY), 'mentioned']) {
      expect(kotlinHandler).toContain(`data["${key}"]`);
      expect(swiftHandler).toContain(`userInfo["${key}"]`);
      expect(objcHandler).toContain(`data[@"${key}"]`);
    }
  });

  it('every key a native handler reads is still sent', () => {
    const sent = new Set([...sentKeys, 'mentioned']);
    // The negative lookahead keeps a WRITE out of the read set: both iOS handlers stamp
    // `content.userInfo["deepLink"] = ...` on the notification they are building, which is the
    // opposite direction from reading the push.
    const read = [
      ...extractKeys(kotlinHandler, /data\["(\w+)"\]/g),
      ...extractKeys(swiftHandler, /userInfo\["(\w+)"\](?!\s*=)/g),
      ...extractKeys(objcHandler, /data\[@"(\w+)"\]/g),
    ];
    for (const key of read) {
      expect({ key, sent: sent.has(key) }).toEqual({ key, sent: true });
    }
  });

  it('the salon title names its community on all four surfaces that compose it', () => {
    // `<Communaute> - #<salon>`, decided 2026-08-16: a salon name alone is ambiguous, two
    // communities may both have a `#general`. FOUR processes can put this banner on a screen and
    // each spells the format itself - the server's copy is the APNs alert title, which is what an
    // iPhone shows when the extension cannot run, so it has to agree with the three that render it.
    expect(serviceSource).toContain('`${workspaceName} - #${channelName}`');
    expect(kotlinSource).toContain('"$workspaceName - #$channelName"');
    expect(swiftHandler).toContain('"\\(workspaceName) - #\\(channelName)"');
    expect(objcHandler).toContain('@"%@ - #%@"');
  });

  it('a mention routes to the higher tier on all three, from the server flag not a text scan', () => {
    // Android has a notification channel for it; iOS has the interruption level. Same fact, the
    // two shapes each platform offers.
    expect(kotlinHandler).toContain('CHANNEL_MENTIONS');
    expect(swiftHandler).toContain('.timeSensitive');
    expect(objcHandler).toMatch(/CanariShowMessageNotification\(.*mentionsMe\)/s);
    // And the flag is the server's, never the `@[uuid]` scan the MLS path has to use: a channel
    // push whose ciphertext was too large to inline carries no text to scan.
    expect(kotlinHandler).not.toContain('@[$');
    expect(swiftHandler).not.toContain('@[\\(');
    expect(objcHandler).not.toContain('@[%@]');
  });
});

/**
 * Which iOS PROCESS a push reaches is decided on the server, and neither side can see the other.
 *
 * `buildInternalApnsRequest` sends a silent frame as `content-available: 1` /
 * `apns-push-type: background`. A background push is delivered to the APP; the Notification Service
 * Extension runs on `mutable-content: 1` ALERT pushes and on nothing else. So a silent type listed
 * in the extension's switch is a branch that cannot execute, and one missing from the app's
 * dispatcher is a frame nobody acts on - which is what `channel_read` was: named in the extension,
 * where it never arrived, so a killed iPhone kept showing a salon banner for a message already read
 * on another device.
 */
describe('silent push frames are handled by the app, never by the extension', () => {
  const payloadSource = readFileSync(PUSH_PAYLOAD_TS, 'utf8');
  const swiftSource = readFileSync(NOTIF_SERVICE_SWIFT, 'utf8');
  const objcSource = readFileSync(CANARI_PUSH_MM, 'utf8');

  /** The `type` values buildInternalApnsRequest turns into a background push. */
  const silentTypes = extractKeys(
    functionBody(payloadSource, /const isSilent =/, /\n {2}\/\//),
    /data\.type === '(\w+)'/g
  );

  /** Every `case` label of the extension's top-level type switch. */
  const nseCases = extractKeys(
    functionBody(swiftSource, /switch type \{/, /\n {4}default:/),
    /"(\w+)"/g
  );

  it('extracted both lists, so nothing below can pass by being empty', () => {
    expect(silentTypes).toEqual(['channel_read']);
    expect(nseCases).toContain('channel');
    expect(nseCases).toContain('social');
    expect(nseCases).toContain('form_reminder');
  });

  it('no silent type is claimed by the extension, which can never receive one', () => {
    for (const type of silentTypes) {
      expect({ type, claimedByNSE: nseCases.includes(type) }).toEqual({
        type,
        claimedByNSE: false,
      });
    }
  });

  it('every silent type is acted on by the app dispatcher, the only process that gets it', () => {
    const dispatcher = functionBody(
      objcSource,
      /static void CanariHandleFcmData\(/,
      /\nvoid CanariPushCancelMessageNotifications\(/
    );
    for (const type of silentTypes) {
      expect({ type, handled: dispatcher.includes(`isEqualToString:@"${type}"`) }).toEqual({
        type,
        handled: true,
      });
    }
  });

  it('the cancel keys on the thread, the only key both posting paths agree on', () => {
    // The in-app path posts `canari-<stableId>`; the extension posts under an identifier the system
    // assigned. Removing by our own identifier therefore matched nothing on a killed iPhone - the
    // exact case a read elsewhere has to clean up. `threadIdentifier` is the conversation on both.
    const cancel = functionBody(
      objcSource,
      /static void CanariCancelConversationNotification\(/,
      /\nstatic NSData \*_Nullable CanariHttpRequest\(/
    );
    expect(cancel).toContain('threadIdentifier');
    expect(cancel).toContain('getDeliveredNotificationsWithCompletionHandler');
  });
});
