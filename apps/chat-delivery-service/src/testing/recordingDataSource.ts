import { DataSource, type EntityManager } from 'typeorm';
import { DeviceGroupMembership } from '../entities/device-group-membership.entity';
import { QueuedMessage } from '../entities/queued-message.entity';
import { QueuedPayload } from '../entities/queued-payload.entity';
import { GroupMember } from '../entities/group-member.entity';
import { GroupMembershipInterval } from '../entities/group-membership-interval.entity';
import { Group } from '../entities/group.entity';
import { KeyPackage } from '../entities/key-package.entity';

/** One statement the REAL TypeORM query builder produced, as the driver would have sent it. */
export interface RecordedStatement {
  sql: string;
  params: unknown[];
}

/**
 * A real TypeORM `DataSource` (postgres dialect) whose queries are RECORDED instead of sent.
 *
 * WRITTEN BECAUSE A STATEMENT-SHAPE MOCK ASSERTS WHAT THE TEST AUTHOR BELIEVES TYPEORM DOES. This
 * runs the real metadata, the real criteria handling (`invalidWhereValuesBehavior` included) and the
 * real SQL generation, and stops at the query runner: what is recorded is the SQL Postgres would
 * receive, in the order it would receive it, with `BEGIN`/`COMMIT` around a transaction. No
 * connection is opened. `answer` decides what each statement returns (default: nothing).
 *
 * It cannot prove anything about LOCKS between two sessions - there is one recorder and no server.
 * What it does prove is the statement order inside each session, which is what lock ordering is.
 */
export async function recordingDataSource(
  answer: (stmt: RecordedStatement) => unknown = () => []
): Promise<{ dataSource: DataSource; manager: EntityManager; statements: RecordedStatement[] }> {
  const dataSource = new DataSource({
    type: 'postgres',
    // `QueuedPayload` because `QueuedMessage.payload` relates to it: metadata refuses a dangling relation.
    entities: [
      DeviceGroupMembership,
      QueuedMessage,
      QueuedPayload,
      GroupMember,
      GroupMembershipInterval,
      Group,
      KeyPackage,
    ],
  });
  // Metadata only: `initialize()` would connect.
  await (dataSource as unknown as { buildMetadatas: () => Promise<void> }).buildMetadatas();
  const statements: RecordedStatement[] = [];
  const record = (sql: string, params: unknown[] = []) => {
    const stmt = { sql, params };
    statements.push(stmt);
    return stmt;
  };
  const runner = {
    connection: dataSource,
    dataSource,
    data: {},
    isTransactionActive: false,
    isReleased: false,
    // Entity listeners and subscribers: none here, so every broadcast (`broadcast`,
    // `broadcastBeforeInsertEvent`, ...) is a no-op the builder may call.
    broadcaster: new Proxy({}, { get: () => () => undefined }),
    async startTransaction() {
      runner.isTransactionActive = true;
      record('BEGIN');
    },
    async commitTransaction() {
      runner.isTransactionActive = false;
      record('COMMIT');
    },
    async rollbackTransaction() {
      runner.isTransactionActive = false;
      record('ROLLBACK');
    },
    async release() {
      runner.isReleased = true;
    },
    async query(sql: string, params: unknown[] = [], useStructuredResult = false) {
      const rows = answer(record(sql, params));
      const records = Array.isArray(rows) ? rows : [];
      return useStructuredResult ? { records, raw: records, affected: records.length } : records;
    },
  };
  (dataSource.driver as unknown as { createQueryRunner: () => unknown }).createQueryRunner = () => {
    runner.isReleased = false;
    (runner as unknown as { manager: EntityManager }).manager = dataSource.createEntityManager(
      runner as never
    );
    return runner;
  };
  return { dataSource, manager: dataSource.manager, statements };
}

/** The table a recorded statement touches, for asserting order without pinning whole SQL. */
export function tableOf(sql: string): string | null {
  const m = /(?:FROM|INTO|UPDATE)\s+"([a-z_]+)"/i.exec(sql);
  return m ? m[1] : null;
}
