// @vitest-environment happy-dom
/**
 * THE REFUSAL THAT DRAWS "FORMAT NON SUPPORTE" NAMES ITS CAUSE. Two voice notes showed the label on
 * the Mi 9T (2026-10-06) and nothing said why; the line must carry the media error's code, the
 * declared type and the engine's own answer for that type, which together separate "this engine
 * cannot play the format" from "the bytes behind the URL are not what the message declares".
 */
import { afterEach, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import { m } from '$lib/paraglide/messages';
import VoiceMessagePlayer from './VoiceMessagePlayer.svelte';

const mounted: (() => void)[] = [];

afterEach(() => {
  while (mounted.length) mounted.pop()!();
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it('an audio error logs its code, the declared type and canPlayType, then shows the label', () => {
  // No decode here: the waveform is not what is tested, and a refused fetch is logged, not thrown.
  vi.stubGlobal('fetch', () => Promise.reject(new Error('no network in this test')));
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const target = document.createElement('div');
  document.body.appendChild(target);
  const component = mount(VoiceMessagePlayer, {
    target,
    props: { src: 'blob:voice', mimeType: 'audio/webm;codecs=opus' },
  });
  mounted.push(() => unmount(component));
  flushSync();

  const audio = target.querySelector('audio')!;
  Object.defineProperty(audio, 'error', {
    configurable: true,
    get: () => ({ code: 3, message: 'PIPELINE_ERROR_DECODE' }),
  });
  audio.canPlayType = vi.fn(() => 'probably' as const);
  audio.dispatchEvent(new Event('error'));
  flushSync();

  const refusal = warn.mock.calls.find(
    ([line]) => typeof line === 'string' && line.includes('refused its source')
  );
  expect(refusal, 'the refusal is logged').toBeDefined();
  expect(refusal![1]).toMatchObject({
    code: 3,
    cause: 'decode',
    message: 'PIPELINE_ERROR_DECODE',
    declaredType: 'audio/webm;codecs=opus',
    canPlayType: 'probably',
  });
  expect(audio.canPlayType).toHaveBeenCalledWith('audio/webm;codecs=opus');
  expect(target.textContent).toContain(m.msg_audio_format_unsupported_label());
});
