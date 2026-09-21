import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The seed a killed phone is handed, across the four files that have to agree about it.
 *
 * A Graine session minted while the app was shut reaches the device once, inside a silent push,
 * and nothing else ever hands it over: dropped, every salon message of that session shows the
 * generic body until the app is next opened. Four halves carry it, in three languages, and NOT
 * ONE of them type-checks against another:
 *
 *   - the server says the conversation is a key-distribution group (`push-payload.ts`);
 *   - the Kotlin service reads that, and only then decrypts a silent frame;
 *   - the Rust decrypt names the frame with a `reason` TOKEN and attaches the seeds
 *     (`mobile/background.rs`, `mobile/proto_fields.rs`), which the Kotlin switches on;
 *   - the Rust writer puts them in `graine_seeds.json` (`commands/push.rs`) under the exact keys
 *     the Kotlin reader looks for.
 *
 * Every one of those seams is a STRING. The native halves are verified by compiling, which says
 * nothing about which keys they read, and the defect a drift produces is not a crash - it is a
 * notification that quietly says less than it could, which is what took this one months to be
 * reported at all. So the strings are pinned here, in both directions.
 */
const here = dirname(fileURLToPath(import.meta.url));

const PUSH_PAYLOAD_TS = resolve(
  here,
  '../../../../apps/chat-delivery-service/src/services/push-payload.ts'
);
const MESSAGING_SERVICE_TS = resolve(
  here,
  '../../../../apps/chat-delivery-service/src/services/messaging.service.ts'
);
const FIREBASE_SERVICE_KT = resolve(
  here,
  '../../../src-tauri/gen/android/app/src/main/java/fr/emse/canari/CanariFirebaseMessagingService.kt'
);
const BACKGROUND_RS = resolve(here, '../../../src-tauri/src/mobile/background.rs');
const PROTO_FIELDS_RS = resolve(here, '../../../src-tauri/src/mobile/proto_fields.rs');
const PUSH_RS = resolve(here, '../../../src-tauri/src/commands/push.rs');
const LIB_RS = resolve(here, '../../../src-tauri/src/lib.rs');

const payload = readFileSync(PUSH_PAYLOAD_TS, 'utf8');
const messaging = readFileSync(MESSAGING_SERVICE_TS, 'utf8');
const kotlin = readFileSync(FIREBASE_SERVICE_KT, 'utf8');
const background = readFileSync(BACKGROUND_RS, 'utf8');
const protoFields = readFileSync(PROTO_FIELDS_RS, 'utf8');
const pushRs = readFileSync(PUSH_RS, 'utf8');
const libRs = readFileSync(LIB_RS, 'utf8');

describe('the cleartext fact that decides whether a silent frame is opened at all', () => {
  it('the server sends it, from the column that already answers it', () => {
    expect(payload).toContain('isKeyDistribution');
    expect(messaging).toContain('distributionWorkspaceId');
    expect(messaging).toContain('distributionChannelId');
    expect(messaging).toContain('isKeyDistribution');
  });

  it('OMITS IT rather than sending false when the row could not be read', () => {
    expect(payload).toMatch(/input\.isKeyDistribution === undefined\s*\n?\s*\?\s*\{\}/);
  });

  it('the Kotlin reads that exact key, and nothing decrypts a silent frame without it', () => {
    expect(kotlin).toContain('data["isKeyDistribution"]');
    // The guard is the whole fix: `silent && !CALLS_ENABLED` alone dropped the seed.
    expect(kotlin).toMatch(/if \(silent && !CALLS_ENABLED && isKeyDistribution != true\)/);
  });

  it('treats an absent key as "not told" rather than as "no" - `!= true`, never `== false`', () => {
    expect(kotlin).not.toMatch(/isKeyDistribution == false/);
  });
});

describe('the reason token the native decrypt chooses and the Kotlin switches on', () => {
  it.each(['graine-key-material', 'graine-request'])('%s is written and read', (token) => {
    expect(background).toContain(`refused("${token}")`);
    expect(kotlin).toContain(`"${token}" ->`);
  });

  it('the seeds ride on the refusal, because the frame must still ring nobody', () => {
    expect(background).toMatch(/out\["seeds"\] = info\["seeds"\]/);
    expect(kotlin).toContain('json.optJSONArray("seeds")');
  });
});

describe('the shape of one seed, from the frame to the mirror to the reader', () => {
  const FIELDS = ['channelId', 'sessionId', 'seedB64', 'createdAt'];

  it.each(FIELDS)('%s is named by the parser and by the JNI writer alike', (field) => {
    expect(protoFields).toContain(`"${field}"`);
    expect(libRs).toContain(`"${field}"`);
  });

  it('the mirror keys the Rust writes are the ones the Kotlin reader asks for', () => {
    // channelId -> sessionId -> { seed, createdAt }. `seed`, not `seedB64`: the transport name
    // and the stored name differ, and conflating them is a silent miss in `lookupGraineSeed`.
    expect(pushRs).toMatch(/"seed":\s*seed_b64/);
    expect(kotlin).toMatch(
      /optJSONObject\(channelId\)[\s\S]{0,80}optJSONObject\(sessionId\)[\s\S]{0,80}optString\("seed"\)/
    );
  });

  it('one file name, on both sides of the mirror', () => {
    expect(pushRs).toContain('graine_seeds.json');
    expect(kotlin).toContain('graine_seeds.json');
  });
});

describe('the JNI symbol, which no compiler here checks', () => {
  it('is declared in Kotlin and exported from Rust under the same name', () => {
    expect(kotlin).toMatch(
      /external fun nativeStoreGraineSeeds\(dataDir: String, seedsJson: String\): Int/
    );
    expect(libRs).toContain(
      'Java_fr_emse_canari_CanariFirebaseMessagingService_nativeStoreGraineSeeds'
    );
  });

  it('is called by the handler, not by the parser - a decrypt must stay read-only', () => {
    expect(kotlin).toMatch(/private fun absorbGraineSeeds\(/);
    expect(kotlin).toContain('nativeStoreGraineSeeds(');
  });
});
