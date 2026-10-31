import {
  SCHEMA_VERSION,
  conversationAwaitingAdmissionStatement,
  conversationStartedAtStatement,
  isFreshDatabase,
  legacyBlobPurgeStatement,
  outboxServerErrorsStatement,
} from './sqliteMigrations';

// Columns of `CREATE TABLE messages` as it stands since the deviceKeyB64 refactor (2c3ec6fe).
const CURRENT_MESSAGE_COLUMNS = ['id', 'conversation_id', 'timestamp', 'iv', 'cipher_text'];
// The same table before that refactor dropped `salt`.
const LEGACY_MESSAGE_COLUMNS = [...CURRENT_MESSAGE_COLUMNS, 'salt'];

describe('isFreshDatabase', () => {
  it('treats a database with no tables and no version as fresh', () => {
    expect(isFreshDatabase([], 0)).toBe(true);
  });

  it('does NOT treat a pre-migration-system database as fresh', () => {
    // The exact case the version alone cannot distinguish: user_version is 0 here too, but the
    // messages table already exists and carries rows that the migrations must still process.
    expect(isFreshDatabase(['conversations', 'messages'], 0)).toBe(false);
  });

  it('does not treat an already-migrated database as fresh', () => {
    expect(isFreshDatabase(['conversations', 'messages', 'outbox'], SCHEMA_VERSION)).toBe(false);
  });

  it('ignores unrelated tables when the messages table is absent', () => {
    // A half-created database (interrupted first launch) still has nothing to migrate.
    expect(isFreshDatabase(['conversations'], 0)).toBe(true);
  });
});

describe('legacyBlobPurgeStatement', () => {
  it('omits salt on the current schema', () => {
    // The regression: naming a dropped column made SQLite throw "no such column: salt" and sent
    // every fresh Tauri install to the IndexedDB fallback.
    const sql = legacyBlobPurgeStatement(CURRENT_MESSAGE_COLUMNS);
    expect(sql).not.toBeNull();
    expect(sql).not.toContain('salt');
    expect(sql).toContain("iv LIKE '[%'");
    expect(sql).toContain("cipher_text LIKE '[%'");
    expect(sql).toContain("typeof(iv) != 'text'");
  });

  it('still inspects salt on a legacy schema that has it', () => {
    expect(legacyBlobPurgeStatement(LEGACY_MESSAGE_COLUMNS)).toContain("salt LIKE '[%'");
  });

  it('returns null when none of the inspected columns exist', () => {
    expect(legacyBlobPurgeStatement(['id', 'conversation_id'])).toBeNull();
  });

  it('drops the typeof guard when iv itself is gone', () => {
    const sql = legacyBlobPurgeStatement(['id', 'cipher_text']);
    expect(sql).toBe("DELETE FROM messages WHERE cipher_text LIKE '[%'");
  });
});

/**
 * v13 -> v14 on a REAL in-memory SQLite (`node:sqlite`, reached through `process.getBuiltinModule`
 * as in `feedPages.test.ts`): rows queued before it read a run of 0, and a rerun does nothing.
 */
describe('outboxServerErrorsStatement (v14)', () => {
  const V13_OUTBOX = `CREATE TABLE outbox (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, sent_at INTEGER,
    kind TEXT, status TEXT, attempts INTEGER DEFAULT 0, last_attempt_at INTEGER, next_attempt_at INTEGER,
    created_at INTEGER, iv TEXT, cipher_text TEXT)`;
  const columnsOf = (engine: any): string[] =>
    engine
      .prepare('PRAGMA table_info(outbox)')
      .all()
      .map((c: { name: string }) => c.name);

  it('adds the column to an existing table, and its queued rows read 0', () => {
    const { DatabaseSync } = process.getBuiltinModule('node:sqlite');
    const engine = new DatabaseSync(':memory:');
    engine.exec(V13_OUTBOX);
    engine.exec(
      "INSERT INTO outbox (id, conversation_id, kind, attempts) VALUES ('a', 'g', 'text', 7)"
    );

    const sql = outboxServerErrorsStatement(columnsOf(engine));
    expect(sql).not.toBeNull();
    engine.exec(sql!);

    expect(engine.prepare('SELECT server_errors, attempts FROM outbox').get()).toEqual({
      server_errors: 0,
      attempts: 7,
    });
    // Rerun: the column is there, nothing to do.
    expect(outboxServerErrorsStatement(columnsOf(engine))).toBeNull();
  });

  it('is a no-op on a fresh database, whose CREATE TABLE already has the column', () => {
    expect(outboxServerErrorsStatement(['id', 'attempts', 'server_errors'])).toBeNull();
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(14);
  });
});

/**
 * v14 -> v15 on a REAL in-memory SQLite: a stored conversation reads NULL - "not an ask" until the
 * next discovery says otherwise - and a rerun does nothing.
 */
describe('conversationAwaitingAdmissionStatement (v15)', () => {
  const columnsOf = (engine: any): string[] =>
    engine
      .prepare('PRAGMA table_info(conversations)')
      .all()
      .map((c: { name: string }) => c.name);

  it('adds the column to an existing conversations table, NULL on every row', () => {
    const { DatabaseSync } = process.getBuiltinModule('node:sqlite');
    const engine = new DatabaseSync(':memory:');
    engine.exec(
      'CREATE TABLE conversations (id TEXT PRIMARY KEY, name TEXT NOT NULL, lifecycle TEXT, image_media_id TEXT)'
    );
    engine.exec(
      "INSERT INTO conversations (id, name, lifecycle) VALUES ('g1', 'Group', 'pending')"
    );

    const sql = conversationAwaitingAdmissionStatement(columnsOf(engine));
    expect(sql).not.toBeNull();
    engine.exec(sql!);

    expect(engine.prepare('SELECT awaiting_admission, lifecycle FROM conversations').get()).toEqual(
      {
        awaiting_admission: null,
        lifecycle: 'pending',
      }
    );
    // Rerun: the column is there, nothing to do.
    expect(conversationAwaitingAdmissionStatement(columnsOf(engine))).toBeNull();
  });

  it('is a no-op on a fresh database, whose CREATE TABLE already has the column', () => {
    expect(conversationAwaitingAdmissionStatement(['id', 'name', 'awaiting_admission'])).toBeNull();
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(15);
  });
});

/**
 * v15 -> v16 on a REAL in-memory SQLite: the group's start was declared persisted and SQLite dropped
 * it on every save. A stored conversation reads NULL - unknown until the next group sweep - and a
 * rerun does nothing.
 */
describe('conversationStartedAtStatement (v16)', () => {
  const columnsOf = (engine: any): string[] =>
    engine
      .prepare('PRAGMA table_info(conversations)')
      .all()
      .map((c: { name: string }) => c.name);

  it('adds the column to an existing conversations table, NULL on every row', () => {
    const { DatabaseSync } = process.getBuiltinModule('node:sqlite');
    const engine = new DatabaseSync(':memory:');
    engine.exec(
      'CREATE TABLE conversations (id TEXT PRIMARY KEY, name TEXT NOT NULL, lifecycle TEXT, awaiting_admission INTEGER)'
    );
    engine.exec("INSERT INTO conversations (id, name, lifecycle) VALUES ('g1', 'Group', 'active')");

    const sql = conversationStartedAtStatement(columnsOf(engine));
    expect(sql).not.toBeNull();
    engine.exec(sql!);

    expect(engine.prepare('SELECT started_at, lifecycle FROM conversations').get()).toEqual({
      started_at: null,
      lifecycle: 'active',
    });
    expect(conversationStartedAtStatement(columnsOf(engine))).toBeNull();
  });

  it('is a no-op on a fresh database, whose CREATE TABLE already has the column', () => {
    expect(conversationStartedAtStatement(['id', 'name', 'started_at'])).toBeNull();
    expect(SCHEMA_VERSION).toBe(16);
  });
});
