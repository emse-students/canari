import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Source guards on the ORDER inside `handleSessionExpired`, which is the whole defect.
 *
 * WHAT BROKE, MEASURED ON W1 ON 2026-08-28. `_sessionExpiredHandled` exists to deduplicate the
 * LOGOUT between the several observers that reach the same verdict at once. It was also gating the
 * lines that release whoever is waiting on the PIN modal right now - and those two questions have
 * different lifetimes. "Has a logout already run for this expiry" is true once; "does this submit
 * need its modal closed" is true again every time. Using the first for the second silenced the
 * trigger: a PIN submit on a client whose refresh cookie was already proven dead threw
 * `SessionExpiredError`, reached this function, and returned at the guard without touching the
 * modal. `handlePinSubmit` clears its watchdog on `onMlsReady` and `onLoginFailed` only, so ten
 * seconds later the spinner unblocked with `auth_pin_timeout` - "please try again" - for a latch
 * that is permanent by design. The user could retry for ever.
 *
 * WHY A SOURCE GUARD AND NOT A RENDER TEST. The behaviour spans a Svelte component's private state,
 * a module-level auth latch and SvelteKit's `goto`; a harness faking all three would assert its own
 * mocks. What actually broke is an ORDER between two statements in one function, which is precisely
 * what a source guard pins well - and what a later edit could reverse with every other test green.
 * Same technique and same reasoning as `session/offlineUnlock.test.ts`.
 */
// FROM `process.cwd()`, NOT FROM `import.meta.url`, WHICH IS WHAT THE SIBLING SOURCE GUARDS USE.
// Under this directory Vite hands the module a non-`file:` `import.meta.url` - the svelte plugin
// processes it - and `fileURLToPath` then throws "The URL must be of scheme file". Vitest runs with
// the frontend root as its working directory, so the path is stated from there.
const source = readFileSync(
  join(process.cwd(), 'src/lib/components/layout/ChatBackgroundService.svelte'),
  'utf8'
);

/** The body of `handleSessionExpired`, from its signature to the next function declaration. */
const handlerBody = (() => {
  const start = source.indexOf('async function handleSessionExpired()');
  expect(start).toBeGreaterThan(-1);
  const rest = source.slice(start + 1);
  const end = rest.search(/\n {2}(?:async )?function /);
  return rest.slice(0, end === -1 ? undefined : end);
})();

describe('a session loss releases every waiting caller, not only the first', () => {
  it('closes the PIN modal before it consults the one-shot logout guard', () => {
    const release = handlerBody.indexOf('dismissAuthPrompts()');
    const guard = handlerBody.indexOf('if (_sessionExpiredHandled)');
    expect(release).toBeGreaterThan(-1);
    expect(guard).toBeGreaterThan(-1);
    // THE ASSERTION IS THE ORDER. Reversed, this is the defect exactly: the second and every later
    // expiry returns with the modal still up and its watchdog still armed.
    expect(release).toBeLessThan(guard);
  });

  it('clears the spinner and the in-progress flags on that same unconditional path', () => {
    const guard = handlerBody.indexOf('if (_sessionExpiredHandled)');
    const before = handlerBody.slice(0, guard);
    // `pinLoading` is cleared inside `dismissAuthPrompts`; these are the flags that would otherwise
    // make `loginImpl` bail silently on the NEXT attempt.
    expect(before).toMatch(/pinError = '';/);
    expect(before).toMatch(/_loginInProgress = false;/);
    expect(before).toMatch(/globalSession\.isLoginInProgress = false;/);
  });

  it('still performs the logout exactly once', () => {
    const guard = handlerBody.indexOf('if (_sessionExpiredHandled)');
    const after = handlerBody.slice(guard);
    // Only a logout may be deduplicated, and it must stay deduplicated: `clearAuth` revokes the
    // refresh cookie server-side, and a second `goto` mid-navigation is a wasted round trip.
    expect(after).toMatch(/_sessionExpiredHandled = true;/);
    expect(after).toMatch(/await clearAuth\(\)/);
    expect(after).toMatch(/goto\('\/login'/);
    expect(handlerBody.slice(0, guard)).not.toMatch(/clearAuth/);
  });

  it('says so when it takes the deduplicated path, rather than returning silently', () => {
    const guard = handlerBody.indexOf('if (_sessionExpiredHandled)');
    const branch = handlerBody.slice(guard, handlerBody.indexOf('return;', guard));
    // EVERY SWALLOWED BRANCH LOGS. This is the branch that used to swallow the whole event, and a
    // line here is the only trace a repeat expiry can leave.
    expect(branch).toMatch(/appendLog\(/);
  });
});

describe('the PIN watchdog stays a net and never becomes the reporter', () => {
  it('is cleared by both callbacks that can end a login', () => {
    const start = source.indexOf('function handlePinSubmit(');
    expect(start).toBeGreaterThan(-1);
    const body = source.slice(start, source.indexOf('\n  /**', start));
    // The watchdog invents a cause (`auth_pin_timeout`) and advises a retry, so any terminal
    // outcome that fails to clear it reports the wrong thing. These two clear it; the third -
    // a definitive session loss - is released by `handleSessionExpired` above, which is why the
    // order asserted there is what keeps this timer from ever being the message the user sees.
    expect(body).toMatch(/onMlsReady: \(\) => \{[\s\S]*?clearTimeout\(watchdog\);/);
    expect(body).toMatch(/onLoginFailed: \([\s\S]*?clearTimeout\(watchdog\);/);
  });
});
