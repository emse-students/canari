/**
 * The salon lane is the ORDER of a salon's unsent messages, and nothing else: whose turn it is, and
 * who goes next when the turn is left (`salonSendLane.ts`).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearSalonLanes,
  joinSalonLane,
  leaveSalonLane,
  reserveSalonLaneTurns,
  salonLanePosition,
  salonLaneTurnAhead,
  takeSalonLaneTurn,
} from './salonSendLane';

const SALON = 'channel_a';
const OTHER = 'channel_b';

beforeEach(() => clearSalonLanes());

describe('one lane per salon', () => {
  it('the first written is the turn; the others wait behind it, in the order they joined', () => {
    for (const id of ['t1', 't2', 't3']) joinSalonLane(SALON, id);
    expect(salonLaneTurnAhead('t1')).toBeNull();
    expect(salonLaneTurnAhead('t2')).toBe('t1');
    expect(salonLaneTurnAhead('t3')).toBe('t1');
    expect(salonLanePosition('t3')).toBe(2);
  });

  it('a repeat keeps its place: joining twice does not move a message to the end', () => {
    for (const id of ['t1', 't2']) joinSalonLane(SALON, id);
    joinSalonLane(SALON, 't1');
    expect(salonLaneTurnAhead('t1')).toBeNull();
    expect(salonLaneTurnAhead('t2')).toBe('t1');
  });

  it('leaving the turn names the message written next; leaving from behind names nobody', () => {
    for (const id of ['t1', 't2', 't3']) joinSalonLane(SALON, id);
    expect(leaveSalonLane('t2')).toBeNull();
    expect(leaveSalonLane('t1')).toBe('t3');
    expect(salonLaneTurnAhead('t3')).toBeNull();
    expect(leaveSalonLane('t3')).toBeNull();
    expect(leaveSalonLane('t3')).toBeNull();
  });

  it('two salons never wait on each other', () => {
    joinSalonLane(SALON, 'a1');
    joinSalonLane(OTHER, 'b1');
    expect(salonLaneTurnAhead('b1')).toBeNull();
  });

  it('a message handed back and sent again goes to the end of the lane', () => {
    for (const id of ['t1', 't2']) joinSalonLane(SALON, id);
    expect(leaveSalonLane('t1')).toBe('t2');
    joinSalonLane(SALON, 't1');
    expect(salonLaneTurnAhead('t1')).toBe('t2');
  });
});

describe("a past page life's leftovers", () => {
  it('are placed ahead of what this page life wrote and has not sent yet', () => {
    joinSalonLane(SALON, 'fresh');
    reserveSalonLaneTurns(SALON, ['old1', 'old2']);
    expect(salonLaneTurnAhead('old1')).toBeNull();
    expect(salonLanePosition('old2')).toBe(1);
    expect(salonLanePosition('fresh')).toBe(2);
  });

  it('but behind the message that already took its turn: it may be on the server', () => {
    joinSalonLane(SALON, 'in-flight');
    takeSalonLaneTurn('in-flight');
    joinSalonLane(SALON, 'fresh');
    reserveSalonLaneTurns(SALON, ['old1', 'old2']);
    expect(salonLaneTurnAhead('old1')).toBe('in-flight');
    expect(salonLanePosition('old1')).toBe(1);
    expect(salonLanePosition('old2')).toBe(2);
    expect(salonLanePosition('fresh')).toBe(3);
  });

  it('an id that already has a place keeps it', () => {
    joinSalonLane(SALON, 'old1');
    joinSalonLane(SALON, 'fresh');
    takeSalonLaneTurn('old1');
    reserveSalonLaneTurns(SALON, ['old1', 'old2']);
    expect(salonLanePosition('old1')).toBe(0);
    expect(salonLanePosition('old2')).toBe(1);
  });
});
