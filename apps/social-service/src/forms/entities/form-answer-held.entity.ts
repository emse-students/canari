import { Column, Entity, Index, ManyToOne, JoinColumn, PrimaryGeneratedColumn } from 'typeorm';
import type { ProductGridLine } from '../product-grid-contract';
import type { RespondentIdentity } from '../respondent-identity';
import { Form } from './form.entity';

/**
 * An anonymous form's answer waiting for its batch (migration 178, `anonymous-answer-batches.ts`).
 *
 * The answer's own columns and nothing else: no account, no address, no timestamp. It moves into
 * `submissions` with the other answers waiting on its form, in one write. Mapped so a database built
 * by `synchronize` (local) has the table; the service reads and writes it in SQL.
 */
@Entity('form_answers_held')
@Index('form_answers_held_form_idx', ['formId'])
export class FormAnswerHeld {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  formId: string;

  /** No cascade, as `submissions`: a form whose answers wait is archived, never removed. */
  @ManyToOne(() => Form, { onDelete: 'NO ACTION' })
  @JoinColumn({ name: 'formId' })
  form?: Form;

  @Column('jsonb', { default: {} })
  answers: Record<string, unknown>;

  @Column({ type: 'jsonb', nullable: true })
  lines: ProductGridLine[] | null;

  @Column({ type: 'jsonb', nullable: true })
  priceLockedItemIds: string[] | null;

  @Column({ type: 'jsonb', nullable: true })
  respondentIdentity: RespondentIdentity | null;
}
