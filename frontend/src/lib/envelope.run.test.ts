/**
 * The CanaRun envelope and the "cannot draw" envelope: stored, parsed back (a history bundle
 * relays the string from a peer, so the parse CHECKS it), previewed.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setLocale } from '$lib/paraglide/runtime';
import {
  envelopeBodyText,
  getPreviewText,
  mkRunEnvelope,
  mkUnsupportedEnvelope,
  parseEnvelope,
  serializeEnvelope,
} from './envelope';
import { appMsgToEnvelope } from '$lib/utils/chat/messageUtils';
import { decodeAppMessage, encodeAppMessage, mkRun } from '$lib/proto/codec';
import { runActivityToProto } from '$lib/canarun/activity';
import { sampleRun } from '../test/canarunFixture';

afterEach(() => {
  setLocale('fr', { reload: false });
  vi.restoreAllMocks();
});

describe('the run envelope', () => {
  it('round-trips through its stored string', () => {
    const env = mkRunEnvelope(sampleRun());
    expect(parseEnvelope(serializeEnvelope(env))).toEqual(env);
  });

  it('is previewed as an activity with its sport and distance', () => {
    setLocale('en', { reload: false });
    expect(getPreviewText(mkRunEnvelope(sampleRun()))).toBe('[Activity] Run · 5.23 km');
    setLocale('fr', { reload: false });
    expect(getPreviewText(mkRunEnvelope(sampleRun()))).toBe('[Activité] Course · 5,23 km');
  });

  it('offers its title as the body an edit would compare', () => {
    const content = serializeEnvelope(mkRunEnvelope(sampleRun()));
    expect(envelopeBodyText(content)).toBe('Footing du matin');
  });

  it('turns a stored run that breaks a bound into the unreadable row, never a crash', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const forged = JSON.stringify({
      kind: 'run',
      run: { ...sampleRun(), trackE5: Array(4000).fill(0), distanceM: -5 },
    });
    expect(parseEnvelope(forged)).toEqual({ kind: 'unsupported', reason: 'malformed-run' });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('stored run refused'));
  });

  it('is built by appMsgToEnvelope from a frame - the function every reading path calls', () => {
    const frame = decodeAppMessage(
      encodeAppMessage({
        ...mkRun(runActivityToProto(sampleRun())),
        messageId: 'run-1',
        sentAt: 1_793_090_000_000,
      })
    )!;
    const out = appMsgToEnvelope(frame, 1_793_099_999_999)!;
    expect(parseEnvelope(out.content)).toEqual(mkRunEnvelope(sampleRun()));
    expect(out.options.messageId).toBe('run-1');
    expect(out.options.timestamp?.getTime()).toBe(1_793_090_000_000);
  });

  it('makes a malformed frame the unreadable row, logged at warn', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const frame = decodeAppMessage(
      encodeAppMessage(mkRun({ ...runActivityToProto(sampleRun()), durationS: 10, movingS: 11 }))
    )!;
    expect(parseEnvelope(appMsgToEnvelope(frame)!.content)).toEqual({
      kind: 'unsupported',
      reason: 'malformed-run',
    });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('refused'));
  });
});

describe('the unsupported envelope', () => {
  it('round-trips, keeping the field number', () => {
    const env = mkUnsupportedEnvelope('unknown-kind', 99);
    expect(parseEnvelope(serializeEnvelope(env))).toEqual(env);
  });

  it('is previewed with the sentence the bubble shows', () => {
    setLocale('en', { reload: false });
    expect(getPreviewText(mkUnsupportedEnvelope('unknown-kind', 99))).toBe(
      'This message needs a newer version of Canari'
    );
    expect(getPreviewText(mkUnsupportedEnvelope('malformed-run'))).toBe(
      'This activity could not be displayed'
    );
  });

  it('has no body to edit', () => {
    expect(envelopeBodyText(serializeEnvelope(mkUnsupportedEnvelope('unknown-kind', 99)))).toBe('');
  });

  it('reads a stored one with an unknown reason as plain text, like any unknown shape', () => {
    const raw = JSON.stringify({ kind: 'unsupported', reason: 'whatever' });
    expect(parseEnvelope(raw)).toEqual({ kind: 'text', text: raw });
  });
});
