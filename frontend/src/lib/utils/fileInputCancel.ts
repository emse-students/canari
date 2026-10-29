import { engineFromUserAgent } from './callE2eReport';

/**
 * Whether this engine's file input ANSWERS EVERY CLOSE of its picker: `change` on a pick, `cancel`
 * on a close with nothing picked. The `cancel` event on a file input shipped in Chromium 113,
 * Firefox 91 and WebKit 16.4; before them a picker closed empty says nothing at all.
 *
 * A fact about the engine, read from its user agent, because no feature test exists: `oncancel` is
 * on `HTMLElement.prototype` for `<dialog>` long before a file input fired it. The agent names only
 * a MAJOR for WebKit (`Safari/16`, `iOS/16`), which cannot tell 16.0 from 16.4, so 16 counts as
 * silent. An unknown engine counts as silent: the cost of a wrong "silent" is one offered tap, the
 * cost of a wrong "answers" is a screen with no way back.
 */
export function fileInputAnswersEveryClose(userAgent: string): boolean {
  const [name, major] = engineFromUserAgent(userAgent).split('/');
  const version = Number(major);
  if (name === 'Chrome') return version >= 113;
  if (name === 'Firefox') return version >= 91;
  if (name === 'Safari' || name === 'iOS') return version >= 17;
  return false;
}
