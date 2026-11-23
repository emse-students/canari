import { Check, Column, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

/**
 * ONE FIGURE OF THE USAGE DASHBOARD (migration 182, docs/wiki/usage-dashboard.md): how many distinct
 * people used Canari, or how many messages, posts, CanaReels, lives, calls or form answers were made,
 * in one Paris day, ISO week or calendar month. NO PERSON IN IT: no account, no device, no content.
 * Written only by the fold (`usage-fold.ts`), which keeps the larger of the stored and the read value;
 * kept with no limit (owner, 2026-11-16).
 */
@Entity('usage_figures')
@Check('usage_figures_period', `period IN ('day', 'week', 'month')`)
@Check('usage_figures_value', `value >= 0`)
export class UsageFigureRow {
  /** `day`, `week` or `month`. */
  @PrimaryColumn({ type: 'varchar', length: 8, primaryKeyConstraintName: 'usage_figures_pkey' })
  period: string;

  /** The period's first Paris day. */
  @PrimaryColumn({ type: 'date', primaryKeyConstraintName: 'usage_figures_pkey' })
  start: string;

  /** `people`, or an activity metric (`messages`, `posts`, `reels`, `lives`, `calls`, `forms`). */
  @PrimaryColumn({ type: 'varchar', length: 16, primaryKeyConstraintName: 'usage_figures_pkey' })
  metric: string;

  /** `all`, `cat:<category>` or `ver:<version>` (a version is at most 32 characters). */
  @PrimaryColumn({ type: 'varchar', length: 48, primaryKeyConstraintName: 'usage_figures_pkey' })
  dimension: string;

  @Column({ type: 'bigint' })
  value: string;

  /** When the fold last raised the value. */
  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
