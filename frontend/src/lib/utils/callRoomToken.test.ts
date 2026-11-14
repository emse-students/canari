import { describe, expect, it } from 'vitest';
import { RoomTokenUnreadableError, roomTokenSeats } from './callRoomToken';

/** A token shaped as chat-delivery signs it: header.payload.signature, base64url. */
function token(claims: Record<string, unknown>): string {
  const enc = (o: unknown) =>
    btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${enc({ alg: 'HS256', typ: 'JWT' })}.${enc(claims)}.sig`;
}

describe('roomTokenSeats (WP-GC2)', () => {
  it('reads the seat cap of a group call', () => {
    expect(roomTokenSeats(token({ room_id: 'r', sub: 'u', group_id: 'g', max_seats: 4 }))).toBe(4);
  });

  it('answers null for a 1:1 call, whose token carries no claim', () => {
    expect(roomTokenSeats(token({ room_id: 'r', sub: 'u', group_id: 'g' }))).toBeNull();
  });

  it('refuses a token that is not a JWT, never guessing a kind', () => {
    expect(() => roomTokenSeats('rt-1')).toThrow(RoomTokenUnreadableError);
    expect(() => roomTokenSeats('a.%%%.c')).toThrow(RoomTokenUnreadableError);
    expect(() => roomTokenSeats(token({ max_seats: '4' }))).toThrow(RoomTokenUnreadableError);
  });
});
