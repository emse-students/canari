// @vitest-environment happy-dom
/**
 * THE PRAGMA ON LINE 1 IS HONOURED (WP-T4). Twin of `environment.test.ts`, which pins that a file
 * without it gets no DOM. If a vitest upgrade stopped reading the pragma, every file that declares it
 * would fail on `document is not defined`; this one names the cause instead of leaving 300 files to.
 */
import { expect, it } from 'vitest';

it('gives a declaring file a working DOM', () => {
  const div = document.createElement('div');
  div.textContent = 'here';
  document.body.append(div);
  expect(document.body.textContent).toContain('here');
  div.remove();
});
