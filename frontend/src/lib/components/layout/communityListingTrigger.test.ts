/**
 * Source guard for the shell's half of community-open-budget F1/F2: the listing starts on the
 * ACCESS TOKEN (a session the server answered for the account on screen), not on MLS-ready, and a
 * sign-out forgets the account's list. Both live in a `.svelte` component no unit test mounts, so
 * this reads its source - the same pattern as `reconnectListingWiring.test.ts`.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const source = readFileSync(
  join(process.cwd(), 'src/lib/components/layout/ChatBackgroundService.svelte'),
  'utf8'
);

describe('ChatBackgroundService - the community listing trigger', () => {
  it('starts the listing before MLS only for an unlock that prompts nobody', () => {
    expect(source).toMatch(
      /const listingMayStart = \$derived\(\s*globalSession\.isLoggedIn \|\|\s*\(sessionAnsweredFor\(\) !== null &&\s*sessionAnsweredFor\(\) === currentUserId\(\) &&\s*unlockUnattendedFor\(\) === currentUserId\(\)\)/
    );
    expect(source).toMatch(/if \(!listingMayStart\) return;/);
  });

  it('forgets the account list on sign-out', () => {
    const handler = source.slice(source.indexOf('function handleSignedOut'));
    expect(handler.slice(0, 1500)).toContain('globalChannels.forgetAccount(appendLog)');
  });
});

const page = readFileSync(join(process.cwd(), 'src/lib/components/MainChatPage.svelte'), 'utf8');
const auth = readFileSync(
  join(process.cwd(), 'src/lib/composables/session/sessionAuth.ts'),
  'utf8'
);

describe('a device that owes an unlock draws nothing of the account before it (F1)', () => {
  it('the saved list is drawn only for an unattended unlock of the account on screen', () => {
    const preview = page.slice(page.indexOf('const isWorkspacePreview = $derived('));
    const body = preview.slice(0, preview.indexOf(');'));
    expect(body).toContain('unlockUnattendedFor() !== null');
    expect(body).toContain('unlockUnattendedFor() === currentUserId()');
  });

  it('a PIN owed and every sign-out mark the device locked, whatever page is shown', () => {
    const open = source.slice(source.indexOf('async function openPinModal('));
    expect(open.slice(0, open.indexOf('if (!mayPromptForPin()) return;'))).toContain(
      'noteUnlockNeedsMember();'
    );
    const out = source.slice(source.indexOf('function handleSignedOut()'));
    expect(out.slice(0, 200)).toContain('noteUnlockNeedsMember();');
  });

  it('only a vault slot whose owner is proven, or a keystore read with no prompt, unlocks unattended', () => {
    expect(source).toContain('if (vaulted.ownerProven) noteUnlockUnattended(savedUser);');
    expect(source).toMatch(
      /if \(promptDue\) noteUnlockNeedsMember\(\);\s*else noteUnlockUnattended\(savedUser\);/
    );
    expect(auth).toContain('if (vaulted.ownerProven) noteUnlockUnattended(userId);');
    // Nothing else in the shell may declare an unlock unattended.
    expect(source.match(/noteUnlockUnattended\(/g)).toHaveLength(2);
  });
});
