import { SCHEMA_VERSION, isFreshDatabase, legacyBlobPurgeStatement } from './sqliteMigrations';

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
