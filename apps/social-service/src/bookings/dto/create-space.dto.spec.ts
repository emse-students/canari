/**
 * `POST bookings/spaces` validates the first hours of the default column (WP-R1, D44) as it
 * validates `PUT resources/:id/availability`: the nested lines go through the same DTO, so a weekday
 * out of range is a 400 before the service runs, never the database's CHECK.
 */
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateSpaceDto } from './space.dto';

const errorsOf = async (body: object) =>
  (await validate(plainToInstance(CreateSpaceDto, body))).map((e) => e.property);

describe('CreateSpaceDto', () => {
  it('accepts a space with no hours, and one with its first hours', async () => {
    expect(await errorsOf({ name: 'Salle de musique' })).toEqual([]);
    expect(
      await errorsOf({
        name: 'Salle de musique',
        availability: {
          lines: [{ weekday: 1, startTime: '08:00', endTime: '20:00' }],
          exceptions: [{ fromDate: '2026-12-24', toDate: '2026-12-26' }],
        },
      })
    ).toEqual([]);
  });

  it('refuses a malformed nested line or closure', async () => {
    expect(
      await errorsOf({
        name: 'x',
        availability: {
          lines: [{ weekday: 9, startTime: '08:00', endTime: '09:00' }],
          exceptions: [],
        },
      })
    ).toEqual(['availability']);
    expect(
      await errorsOf({ name: 'x', availability: { lines: [], exceptions: [{ fromDate: 'soon' }] } })
    ).toEqual(['availability']);
    expect(await errorsOf({ name: 'x', availability: { lines: [] } })).toEqual(['availability']);
  });

  it("takes a slot length in the wizard's range (15..120 min, whole), or null; nothing else", async () => {
    for (const ok of [15, 25, 120, null]) {
      expect(await errorsOf({ name: 'x', slotMode: 'slots', slotMinutes: ok })).toEqual([]);
    }
    for (const bad of [14, 121, 22.5, '30', 0]) {
      expect(await errorsOf({ name: 'x', slotMode: 'slots', slotMinutes: bad })).toEqual([
        'slotMinutes',
      ]);
    }
  });
});
