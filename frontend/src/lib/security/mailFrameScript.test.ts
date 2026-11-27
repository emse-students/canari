/**
 * THE MAIL FRAME'S ONE SCRIPT IS ALLOWED BY ITS HASH, THE SAME IN EVERY POLICY THAT GOVERNS IT.
 *
 * A `srcdoc` frame runs a script only if its own policy AND its parent's allow it, so the hash of
 * `MAIL_FRAME_SCRIPT` must be in the frame's policy (`mailFramePolicy`), the web page's
 * (`WEB_POLICY_DIRECTIVES`, which nginx's `csp.conf` must equal - `csp.test.ts`) and the native
 * WebView's (`tauri.conf.json`, release and dev). The hash is written down once
 * (`MAIL_FRAME_SCRIPT_HASH`) and computed here from the text: an edit of the script that forgets
 * the hash fails HERE, naming the new one, never as a silently dead frame.
 */
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { mailFramePolicy } from '$lib/mail/mailHtml';
import { WEB_POLICY_DIRECTIVES } from './cspDirectives.js';
import { MAIL_FRAME_SCRIPT, MAIL_FRAME_SCRIPT_HASH } from './mailFrameScript.js';

const computed = `sha256-${createHash('sha256').update(MAIL_FRAME_SCRIPT, 'utf8').digest('base64')}`;

describe('the mail frame script hash', () => {
  it('is the hash of the script text', () => {
    expect(MAIL_FRAME_SCRIPT_HASH, `write ${computed} in the three places`).toBe(computed);
  });

  it("is the only script the frame's own policy allows", () => {
    for (const shown of [false, true]) {
      const scriptSrc = mailFramePolicy(shown)
        .split(';')
        .map((d) => d.trim())
        .find((d) => d.startsWith('script-src'));
      expect(scriptSrc).toBe(`script-src '${computed}'`);
    }
  });

  it('is in the web page policy, and so in nginx csp.conf', () => {
    expect(WEB_POLICY_DIRECTIVES['script-src']).toContain(computed);
    const dockerfile = readFileSync(
      resolve(process.cwd(), '../infrastructure/local/Dockerfile.frontend'),
      'utf8'
    );
    expect(dockerfile).toContain(computed);
  });

  it('is in the native WebView policy, release and dev', () => {
    const security = JSON.parse(
      readFileSync(resolve(process.cwd(), 'src-tauri/tauri.conf.json'), 'utf8')
    ).app.security;
    expect(security.csp['script-src'].split(/\s+/)).toContain(`'${computed}'`);
    expect(security.devCsp['script-src'].split(/\s+/)).toContain(`'${computed}'`);
  });

  it('carries nothing that would end its element early', () => {
    expect(MAIL_FRAME_SCRIPT).not.toMatch(/<\/script/i);
  });
});
