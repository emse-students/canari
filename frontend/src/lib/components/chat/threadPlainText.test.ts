/**
 * THE THREAD'S SEPARATORS AND SYSTEM LINES ARE PLAIN MUTED TEXT (design audit Q6-Q9, 2026-11-09):
 * Messenger draws a day, an hour and "X added a device" as text, never as a boxed, uppercase,
 * tracked pill. No rendering test sees a style drift, so the gate reads the sources.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { getPreviewText } from '$lib/envelope';

const groups = readFileSync('src/lib/components/chat/ChatMessageGroups.svelte', 'utf8');
const bubble = readFileSync('src/lib/components/messages/MessageBubble.svelte', 'utf8');
const settings = readFileSync('src/routes/settings/+page.svelte', 'utf8');

describe('thread separators', () => {
  const block = groups.slice(
    groups.indexOf("group?.type === 'date_separator'"),
    groups.indexOf("{:else if group?.type === 'message'")
  );
  it('keep the date hook the sticky pill reads, in one plain muted style', () => {
    expect(block).toContain('data-chat-date-separator');
    expect(block).not.toMatch(/uppercase|tracking-|shadow-|border|rounded/);
  });
});

describe('system line', () => {
  it('is plain centred muted text, without box or glyph', () => {
    const i = bubble.indexOf('text-text-muted max-w-md text-center text-xs');
    expect(i).toBeGreaterThan(0);
    const line = bubble.slice(i - 40, i + 200);
    expect(line).not.toMatch(/border|shadow|bg-/);
    expect(bubble).not.toContain('<Info ');
  });
});

describe('system row box', () => {
  // The id is decided in MessageBubble by its own `effectiveSystem` (isSystem OR a system envelope),
  // so a row the wrapper does not call system still gets exactly one `msg-` element.
  it('both system roots of MessageBubble carry the msg- id, like the bubble', () => {
    const start = bubble.indexOf('{#if effectiveSystem}');
    const end = bubble.indexOf('bind:this={bubbleAnchor}');
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const system = bubble.slice(start, end);
    expect(system.split('id={`msg-${messageId}`}').length - 1).toBe(2);
    expect(bubble.split('id={`msg-${messageId}`}').length - 1).toBe(3);
  });
  it('the wrapper adds none: a second element with the same id would shadow the first', () => {
    expect(groups).not.toContain('id={`msg-');
  });
});

describe('internals stay off user surfaces', () => {
  it('a system preview carries no [Info] prefix', () => {
    expect(getPreviewText({ kind: 'system', text: 'Appel manque' } as never)).toBe('Appel manque');
  });
  it('Settings prints no device id', () => {
    expect(settings).not.toMatch(/myDeviceId|settings_device_id_label/);
  });
});
