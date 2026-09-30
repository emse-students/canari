import { Entity, PrimaryColumn } from 'typeorm';

/**
 * "This account has already answered this ANONYMOUS form", and nothing else.
 *
 * It deliberately has no submission id and no timestamp: either would let a reader of the database
 * join this table back to the answers and recover exactly the identity the form promised to forget.
 * Its one job is the uniqueness a non-repeatable form needs (migration 067).
 */
@Entity('form_respondents')
export class FormRespondent {
  @PrimaryColumn({ type: 'uuid' })
  formId: string;

  @PrimaryColumn({ type: 'varchar', length: 255 })
  userId: string;
}
