/**
 * THE BELL'S GATE TABLE AGREES WITH THE TWO LISTS THE READ ALREADY HAD: every kind `BELL_ROW_GATE`
 * calls post-bound is in `POST_BOUND_NOTIFICATION_TYPES` and the reverse, the birthday is the
 * birthday, and every target-bound kind has an arm in `targetBoundRowShownSql`. The compiler holds
 * the table exhaustive over `NotificationType`; this holds it to the lists it did not replace.
 */
import {
  BELL_ROW_GATE,
  TARGET_BOUND_NOTIFICATION_TYPES,
  targetBoundRowShownSql,
} from './bell-row-gates';
import { BIRTHDAY_NOTIFICATION } from '../birthdays/birthday-notification';
import { POST_BOUND_NOTIFICATION_TYPES } from './post-notifications.service';
import { NOTIFICATION_TYPE_MIN_CLIENT } from '../push/notification-client-floor';

const kinds = (gate: string) =>
  Object.entries(BELL_ROW_GATE)
    .filter(([, g]) => g === gate)
    .map(([type]) => type)
    .sort();

describe('BELL_ROW_GATE', () => {
  it('names every bell kind, and nothing else', () => {
    expect(Object.keys(BELL_ROW_GATE).sort()).toEqual(
      Object.keys(NOTIFICATION_TYPE_MIN_CLIENT).sort()
    );
  });

  it('calls post-bound exactly the kinds the post re-check reads', () => {
    expect(kinds('post')).toEqual([...POST_BOUND_NOTIFICATION_TYPES].sort());
  });

  it('calls the birthday the birthday', () => {
    expect(kinds('birthday')).toEqual([BIRTHDAY_NOTIFICATION]);
  });

  it('gives every target-bound kind one arm of the CASE, and no other kind one', () => {
    const sql = targetBoundRowShownSql('n');
    for (const type of Object.keys(BELL_ROW_GATE)) {
      const armed = sql.includes(`WHEN '${type}' THEN`);
      expect([type, armed]).toEqual([
        type,
        TARGET_BOUND_NOTIFICATION_TYPES.includes(type as never),
      ]);
    }
    expect(sql.endsWith('ELSE true END)')).toBe(true);
  });

  it('re-asks the event and proposal kinds the audit of 2026-11-14 named', () => {
    expect([...TARGET_BOUND_NOTIFICATION_TYPES].sort()).toEqual(
      expect.arrayContaining([
        'coorganise_proposed',
        'event_deleted',
        'event_open',
        'event_pending',
        'event_pending_coorganiser',
        'event_proposed',
        'event_rejected',
        'event_updated',
        'event_validated',
        'repost_proposed',
      ])
    );
  });
});
