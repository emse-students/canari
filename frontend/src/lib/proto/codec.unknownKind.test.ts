/**
 * A KIND NEWER THAN THIS BUILD IS SHOWN, NOT DROPPED (CanaRun R1, decided 2026-10-27).
 *
 * Detected from the field numbers the decoder could not place - never from any text - and only for
 * a frame carrying NO kind this build knows, so every control kind keeps its own route.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import protobuf from 'protobufjs/minimal.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  APP_MESSAGE_FIELD_NUMBERS,
  APP_MESSAGE_KINDS,
  decodeAppMessage,
  encodeAppMessage,
  mkEdit,
  mkGraineRequest,
  mkReaction,
  mkRun,
  mkSystem,
  mkCallHangup,
  mkText,
  unknownAppMessageKind,
} from './codec';
import { appMsgToEnvelope, isDisplayedDmKind } from '$lib/utils/chat/messageUtils';
import { parseEnvelope } from '$lib/envelope';
import { runActivityToProto } from '$lib/canarun/activity';
import { sampleRun } from '../../test/canarunFixture';

const PROTO = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../../../../libs/proto/canari.proto'),
  'utf8'
);

/** An AppMessage carrying `message_id`, `sent_at` and a field 99 in place of any kind. */
function futureKindFrame(field = 99): Uint8Array {
  const w = protobuf.Writer.create();
  w.uint32((6 << 3) | 2).string('future-1');
  w.uint32((8 << 3) | 0).int64(1_793_088_000_000);
  w.uint32((field << 3) | 2).bytes(new Uint8Array([0x0a, 0x02, 0x68, 0x69]));
  return w.finish();
}

afterEach(() => vi.restoreAllMocks());

describe('the lists this build knows match the proto', () => {
  const block = PROTO.slice(PROTO.indexOf('message AppMessage {'));
  const body = block.slice(0, block.search(/\r?\n\}\r?\n/));
  const oneof = body.slice(body.indexOf('oneof kind {'), body.indexOf('}'));
  const camel = (s: string) => s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());

  it('APP_MESSAGE_KINDS is the oneof, in order', () => {
    const names = [...oneof.matchAll(/^\s*\w+\s+(\w+)\s*=\s*\d+;/gm)].map((m) => camel(m[1]));
    expect(names).toEqual([...APP_MESSAGE_KINDS]);
  });

  it('APP_MESSAGE_FIELD_NUMBERS is every field number of AppMessage', () => {
    const numbers = [...body.matchAll(/^\s*\w+\s+\w+\s*=\s*(\d+);/gm)].map((m) => Number(m[1]));
    expect(new Set(numbers)).toEqual(APP_MESSAGE_FIELD_NUMBERS);
  });
});

describe('unknownAppMessageKind', () => {
  it('names the field of a kind this build does not know', () => {
    const msg = decodeAppMessage(futureKindFrame())!;
    expect(msg.messageId).toBe('future-1');
    expect(unknownAppMessageKind(msg)).toBe(99);
  });

  it('is null for every kind this build knows, control kinds included', () => {
    for (const frame of [
      mkText('x'),
      mkReaction('m1', '+1', 1),
      mkSystem('read_watermark', '{}'),
      mkCallHangup('c1'),
      mkEdit('m1', 'y', 1),
      mkGraineRequest({ workspaceId: 'w' }),
      mkRun(runActivityToProto(sampleRun())),
    ]) {
      expect(unknownAppMessageKind(decodeAppMessage(encodeAppMessage(frame))!)).toBeNull();
    }
  });

  it('is null for a known kind beside an unknown field - a newer writer, not a newer kind', () => {
    const w = protobuf.Writer.create();
    w.uint32((1 << 3) | 2).fork().uint32((1 << 3) | 2).string('hello').ldelim();
    w.uint32((99 << 3) | 2).bytes(new Uint8Array([1]));
    expect(unknownAppMessageKind(decodeAppMessage(w.finish())!)).toBeNull();
  });

  it('is null for a frame that carries nothing at all', () => {
    expect(unknownAppMessageKind(decodeAppMessage(new Uint8Array())!)).toBeNull();
  });
});

describe('appMsgToEnvelope on a newer kind', () => {
  it('answers the "needs a newer version" row, logged at warn with the field number', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const out = appMsgToEnvelope(decodeAppMessage(futureKindFrame())!);
    expect(out).not.toBeNull();
    expect(parseEnvelope(out!.content)).toEqual({
      kind: 'unsupported',
      reason: 'unknown-kind',
      field: 99,
    });
    expect(out!.options.messageId).toBe('future-1');
    expect(out!.options.timestamp?.getTime()).toBe(1_793_088_000_000);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('kind field 99'));
  });

  it('still answers null for the control kinds, which keep their own route', () => {
    for (const frame of [
      mkReaction('m1', '+1', 1),
      mkSystem('history_bundle', '{}'),
      mkCallHangup('c1'),
      mkEdit('m1', 'y', 1),
      mkGraineRequest({ workspaceId: 'w' }),
    ]) {
      expect(appMsgToEnvelope(decodeAppMessage(encodeAppMessage(frame))!)).toBeNull();
    }
  });

  it('is a displayed kind on the DM path; the control kinds are not', () => {
    expect(isDisplayedDmKind(decodeAppMessage(futureKindFrame())!)).toBe(true);
    expect(isDisplayedDmKind(decodeAppMessage(encodeAppMessage(mkRun({})))!)).toBe(true);
    expect(isDisplayedDmKind(decodeAppMessage(encodeAppMessage(mkReaction('m', 'x', 1)))!)).toBe(
      false
    );
    expect(isDisplayedDmKind(decodeAppMessage(encodeAppMessage(mkEdit('m', 'y', 1)))!)).toBe(
      false
    );
  });
});
