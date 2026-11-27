/**
 * The account's notification settings, ANSWERED, for a test that is not about them.
 *
 * Every notification and call-ring decision waits for the first answer of the sign-in read
 * (`notificationPreferences.answered`): until then the store holds the account default, not the
 * account's choice. A test about something else stubs that read with the default and has it answered
 * before its first arrival, so its decisions run at the instant they always did.
 *
 * Use both halves, the mock first (it is hoisted):
 *
 *   vi.mock('$lib/notifications/preferencesApi', async (orig) =>
 *     (await import('../../test/answeredPreferences')).answeringTheDefault(orig)
 *   );
 *   await (await import('../../test/answeredPreferences')).answerPreferences();
 */
import type * as PreferencesApi from '$lib/notifications/preferencesApi';

/** What the server answers for an account that never changed a setting. */
export const ACCOUNT_DEFAULT_PREFERENCES = {
  disabled: [],
  pushEnabled: [],
  unknownDisabled: [],
  groupLevels: {},
  groupCalls: {},
};

/**
 * The real `preferencesApi` module with its sign-in read answering the account default.
 *
 * @param orig - vitest's `importOriginal` of the mocked module.
 */
export async function answeringTheDefault(orig: () => Promise<unknown>) {
  return {
    ...((await orig()) as typeof PreferencesApi),
    fetchNotificationPreferences: async () => ({ ...ACCOUNT_DEFAULT_PREFERENCES }),
  };
}

/** Runs the sign-in read once, so every decision of the file finds the set answered. */
export async function answerPreferences(): Promise<void> {
  const { notificationPreferences } = await import('$lib/stores/notificationPreferences.svelte');
  if (!(await notificationPreferences.load())) {
    throw new Error('answerPreferences: the stubbed read did not answer - is the mock in place?');
  }
}
