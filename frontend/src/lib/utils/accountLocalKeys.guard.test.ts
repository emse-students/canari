import { relativeTo, sourceFiles } from '../../test/sourceTree';
import { ACCOUNT_KEY, keystoreAlias } from './accountLocalKeys';

/**
 * THE PER-ACCOUNT KEY LIST IS THE ONE LIST, AND THIS IS WHAT KEEPS IT SO.
 *
 * An account deletion sweeps exactly the keys `accountLocalKeys.ts` lists (an allowlist, by design).
 * A per-account key written anywhere else is a key the deletion leaves behind - and the review of
 * #2023 found nine, one of them the PLAINTEXT of unsent salon messages. Nothing at run time can tell
 * a forgotten key from a deliberate one, so the source is read instead, one case per rule:
 *
 * 1. each listed key's literal head appears in `accountLocalKeys.ts` and nowhere else - a module
 *    keeping its own `const PREFIX = '...'` copy fails here;
 * 2. the keystore alias is built by `keystoreAlias` alone;
 * 3. no `localStorage`/`sessionStorage` call builds its key inline;
 * 4. no key-shaped template literal interpolates a user id outside the list - a module-local
 *    `keyFor(userId)` fails here, and so does a concatenation (`'x_' + userId`, `PREFIX + userId`).
 *    The few names that are NOT storage keys are named with a reason.
 */

const LIST_FILE = 'lib/utils/accountLocalKeys.ts';

const SOURCES = sourceFiles({
  under: 'src',
  extensions: ['ts', 'svelte'],
  tests: 'exclude',
  skipDirs: ['proto'],
}).map(({ path, text }) => ({ file: relativeTo(path, 'src'), text }));

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The literal text a builder puts before its first id - what a copy of it would spell out. */
function headOf(build: (a: string, b: string) => string): string {
  const SENTINEL = '\u0001';
  const key = build(SENTINEL, SENTINEL);
  return key.slice(0, key.indexOf(SENTINEL));
}

/** Where `head` is spelled as a whole string literal, or opens a template that interpolates. */
function filesSpelling(head: string): string[] {
  const re = new RegExp(`(['"])${escape(head)}\\1|\`${escape(head)}\\$\\{`);
  return SOURCES.filter((s) => s.file !== LIST_FILE && re.test(s.text)).map((s) => s.file);
}

describe('the per-account key list is the one list', () => {
  it('reads the source it guards', () => {
    expect(SOURCES.some((s) => s.file === LIST_FILE)).toBe(true);
    expect(SOURCES.length).toBeGreaterThan(100);
  });

  it.each(Object.entries(ACCOUNT_KEY))(
    'rule 1 - the head of `%s` is spelled only in the list',
    (_name, build) => {
      const head = headOf(build as (a: string, b: string) => string);
      expect(head.length).toBeGreaterThan(3);
      expect(filesSpelling(head)).toEqual([]);
    }
  );

  it('rule 2 - the keystore alias is built by keystoreAlias alone', () => {
    expect(filesSpelling(headOf(keystoreAlias))).toEqual([]);
  });

  /** Inline storage keys that are NOT per account, each with the reason it may stay inline. */
  const INLINE_STORAGE_KEYS_NOT_PER_ACCOUNT: Record<string, string> = {
    'localStorage.removeItem(`discovery_pending:${groupId}`':
      'keyed by a conversation, which a deletion does not enumerate',
  };

  it('rule 3 - no storage call builds its key inline', () => {
    const re =
      /(?:local|session)Storage\.(?:get|set|remove)Item\(\s*(?:`[^`]*`|['"][^'"]*['"]\s*\+)/g;
    const found = SOURCES.flatMap((s) =>
      [...s.text.matchAll(re)]
        .map((m) => m[0].replace(/\s+/g, ' '))
        .filter(
          (m) => !Object.keys(INLINE_STORAGE_KEYS_NOT_PER_ACCOUNT).some((k) => m.startsWith(k))
        )
        .map((m) => `${s.file}: ${m}`)
    );
    expect(found).toEqual([]);
  });

  /** Key-shaped names built from a user id that are NOT `localStorage` keys, each with its reason. */
  const USER_NAMES_NOT_STORAGE_KEYS: Record<string, string> = {
    'lib/db/deviceKeyGate.ts:`canari-device-key:${userId}':
      'a Web Lock name, which holds nothing once released',
    'lib/db/indexeddb.ts:`CanariDB_${userId}': 'a database name - deleted by accountIndexedDbNames',
    'lib/db/sqlite.ts:`sqlite:canari_${userId}':
      'a native database path - deleted by delete_user_database',
    'lib/utils/accountLocalWipe.ts:`CanariDB_${userId}': 'accountIndexedDbNames itself',
    'lib/utils/accountLocalWipe.ts:`CanariDBOutbox_${userId}': 'accountIndexedDbNames itself',
    'lib/utils/accountLocalWipe.ts:`CanariDBMls_${userId}': 'accountIndexedDbNames itself',
    'lib/utils/chat/actions.ts:`canari-backup-${userId}':
      'the file name of a backup the user saves',
    'lib/calendar/ics.ts:`UID:${icsEscapeText(ev.uid)}': "an iCalendar event's UID line",
    'lib/mls-client/sendRatchetLedger.ts:`send_ratchet_emitted:${userId}':
      'a record in CanariDBMls_<id> - deleted with that database by accountIndexedDbNames',
  };

  it('rule 4 - no key-shaped literal interpolates a user id outside the list', () => {
    const re =
      /`[A-Za-z][A-Za-z0-9_.:-]*[_.:-]\$\{[^}]*(?:[uU]ser[A-Za-z]*|\buid\b|savedUser)[^}]*\}/g;
    const found = SOURCES.filter((s) => s.file !== LIST_FILE).flatMap((s) =>
      [...s.text.matchAll(re)]
        .map((m) => `${s.file}:${m[0]}`)
        .filter((hit) => !Object.keys(USER_NAMES_NOT_STORAGE_KEYS).some((k) => hit.startsWith(k)))
    );
    expect(found).toEqual([]);
  });

  /** Concatenated names built from a user id that are NOT `localStorage` keys, each with its reason. */
  const USER_CONCATENATIONS_NOT_STORAGE_KEYS: Record<string, string> = {
    'lib/db/outboxBlob.ts:DB_PREFIX + userId':
      '`CanariDBOutbox_` + id, a database name - deleted by accountIndexedDbNames',
    'lib/utils/hex.ts:IDB_NAME + userId':
      '`CanariDBMls_` + id, a database name - deleted by accountIndexedDbNames',
  };

  it('rule 4 - nor does a string concatenation (a literal or a CONSTANT, then + a user id)', () => {
    // The shape `migration.ts` used for the legacy conversations (`'canari_conv_' + userId + '_'`),
    // which rule 4's template-literal pattern never saw.
    const re =
      /(?:(['"])[A-Za-z][A-Za-z0-9_.:-]*[_.:-]\1|\b[A-Z][A-Z0-9_]{2,})\s*\+\s*(?:[A-Za-z_$][\w$]*\.)*[\w$]*(?:[uU]ser[A-Za-z]*|\buid\b|savedUser)/g;
    const found = SOURCES.filter((s) => s.file !== LIST_FILE).flatMap((s) =>
      [...s.text.matchAll(re)]
        .map((m) => `${s.file}:${m[0]}`)
        .filter((hit) => !(hit in USER_CONCATENATIONS_NOT_STORAGE_KEYS))
    );
    expect(found).toEqual([]);
  });

  it('rule 4 catches the concatenation shapes it is written for', () => {
    const re =
      /(?:(['"])[A-Za-z][A-Za-z0-9_.:-]*[_.:-]\1|\b[A-Z][A-Z0-9_]{2,})\s*\+\s*(?:[A-Za-z_$][\w$]*\.)*[\w$]*(?:[uU]ser[A-Za-z]*|\buid\b|savedUser)/;
    for (const shape of [
      "'canari_conv_' + userId",
      '"x:" + this.userId',
      'DB_PREFIX + userId',
      'IDB_NAME + ctx.getUserId',
    ]) {
      expect(re.test(shape), shape).toBe(true);
    }
    expect(re.test("'Bearer ' + token")).toBe(false);
  });
});
