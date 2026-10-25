import type { UserGroupRow } from '$lib/mls-client/IMlsService';
import type { Conversation } from '$lib/types';
import { isNeverAdmitted, syncAdmissionFlags } from './admissionState';

const row = (lifecycle: Conversation['lifecycle'], awaitingAdmission?: boolean): Conversation => ({
  id: 'g1',
  contactName: 'g1',
  name: 'Groupe',
  messages: [],
  lifecycle,
  mlsStateHex: null,
  ...(awaitingAdmission === undefined ? {} : { awaitingAdmission }),
});

const listed = (deviceMembership?: UserGroupRow['deviceMembership']): UserGroupRow[] => [
  {
    groupId: 'g1',
    name: 'Groupe',
    isGroup: true,
    ...(deviceMembership === undefined ? {} : { deviceMembership }),
  } as UserGroupRow,
];

const seat = (awaitingAdmission?: boolean) =>
  ({
    status: 'pending',
    welcomeQueued: false,
    addInFlight: false,
    admitted: false,
    ...(awaitingAdmission === undefined ? {} : { awaitingAdmission }),
  }) as UserGroupRow['deviceMembership'];

describe('isNeverAdmitted', () => {
  it('is an ask on a row this device was never in', () => {
    expect(isNeverAdmitted(row('pending', true))).toBe(true);
  });

  it('is never an active or removed row, nor one with no flag', () => {
    expect(isNeverAdmitted(row('active', true))).toBe(false);
    expect(isNeverAdmitted(row('removed', true))).toBe(false);
    expect(isNeverAdmitted(row('pending'))).toBe(false);
  });
});

describe('syncAdmissionFlags', () => {
  it("sets the flag from the list's word on this device's seat, and reports the change once", () => {
    const conversations = new Map([['g1', row('pending')]]);

    expect(syncAdmissionFlags(conversations, listed(seat(true)))).toEqual(['g1']);
    expect(conversations.get('g1')?.awaitingAdmission).toBe(true);
    expect(syncAdmissionFlags(conversations, listed(seat(true)))).toEqual([]);
  });

  it('clears it once the seat is admitted, and never flags a row this device is in', () => {
    const conversations = new Map([['g1', row('pending', true)]]);
    expect(syncAdmissionFlags(conversations, listed(seat(false)))).toEqual(['g1']);
    expect(conversations.get('g1')?.awaitingAdmission).toBe(false);

    const active = new Map([['g1', row('active')]]);
    expect(syncAdmissionFlags(active, listed(seat(true)))).toEqual([]);
  });

  it('leaves the row alone when the server does not say - an older server, or no seat row', () => {
    const conversations = new Map([['g1', row('pending', true)]]);

    expect(syncAdmissionFlags(conversations, listed())).toEqual([]);
    expect(syncAdmissionFlags(conversations, listed(null))).toEqual([]);
    expect(syncAdmissionFlags(conversations, listed(seat()))).toEqual([]);
    expect(conversations.get('g1')?.awaitingAdmission).toBe(true);
  });
});
