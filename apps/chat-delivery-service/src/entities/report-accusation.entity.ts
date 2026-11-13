import { Entity, PrimaryColumn, Column } from 'typeorm';

/**
 * One item an hourly health report has ACCUSED, in the exact state it accused (migration 049).
 *
 * THE QUESTION THIS ROW ANSWERS, AND THE ONLY ONE: "was this item already accused in this exact
 * state?". It never answers "is this item broken" - the report's own query answers that every hour,
 * from the tables that hold the fact. So the row is written only when an item is accused (first
 * sighting, or a state that differs from the one stored), and deleted the hour the report stops
 * naming the item. A report that read this table to decide what is broken would silence the trigger
 * it exists to de-duplicate (CLAUDE.md, "durable state answers only THE QUESTION IT WAS WRITTEN FOR").
 *
 * `state` is the report's own fingerprint of what made the item accusable - a hole's first missing
 * epoch and size, a conversation's holder count, the seats a stranded device holds - and nothing that
 * moves while the defect stands still (a group's head epoch, a clock). Equal state means the same
 * accusation, so it is not printed again; a different state is a new accusation.
 *
 * Idempotent across replicas: the claim is ONE `INSERT ... ON CONFLICT DO UPDATE ... WHERE state
 * differs ... RETURNING`, so of two replicas running the same report only the one whose statement
 * wrote the row accuses (utils/report-accusations.ts). No clock decides anything; `accusedAt` is
 * printed, never compared.
 *
 * `itemId` is a group id, or a device id for the stranded-device report; it is not an account
 * column, and a device erased with its account leaves this table the next hour, when the report no
 * longer names it.
 */
@Entity('report_accusations')
export class ReportAccusation {
  /** The report that accused the item (`REPORT_KINDS` in utils/report-accusations.ts). */
  @PrimaryColumn({ type: 'varchar', length: 64 })
  report: string;

  /** The item the report names - a group id, or a device id. */
  @PrimaryColumn({ type: 'varchar', length: 512 })
  itemId: string;

  /** The report's fingerprint of the state it accused. */
  @Column({ type: 'text' })
  state: string;

  /** When this state was accused - printed by the daily summary, never compared. */
  @Column({ type: 'timestamptz', default: () => 'now()' })
  accusedAt: Date;
}
