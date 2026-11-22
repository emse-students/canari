import { Entity, JoinColumn, ManyToOne, PrimaryColumn } from 'typeorm';
import { Form } from './form.entity';

/**
 * "This anonymous form's short tail was released once" (migration 178, `anonymous-answer-batches.ts`):
 * a later short tail waits for a full batch or the form's retirement. Mapped so a database built by
 * `synchronize` (local) has the table; the service reads and writes it in SQL.
 */
@Entity('form_anonymous_tail_released')
export class FormAnonymousTailReleased {
  @PrimaryColumn({ type: 'uuid' })
  formId: string;

  @ManyToOne(() => Form, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'formId' })
  form?: Form;
}
