import { describe, expect, it } from 'vitest';
import { bulkWindowHolds } from './bulkIngestAdmission';

describe('bulkWindowHolds', () => {
  it("holds a peer's message, framed or not", () => {
    expect(bulkWindowHolds({ own: false, framed: true, soleWriter: false })).toBe(true);
    expect(bulkWindowHolds({ own: false, framed: false, soleWriter: false })).toBe(true);
  });

  it("holds an own message decrypted from a frame (this account's other device)", () => {
    expect(bulkWindowHolds({ own: true, framed: true, soleWriter: false })).toBe(true);
  });

  it('lets an own message this device composed through: nothing else will ever write it (WP-ECHO-1)', () => {
    expect(bulkWindowHolds({ own: true, framed: false, soleWriter: false })).toBe(false);
  });

  it('lets a sole-writer notice through, whoever its sender is', () => {
    expect(bulkWindowHolds({ own: false, framed: true, soleWriter: true })).toBe(false);
    expect(bulkWindowHolds({ own: true, framed: true, soleWriter: true })).toBe(false);
  });
});
