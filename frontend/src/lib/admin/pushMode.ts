/**
 * What an MLS push tells Google and Apple - the estate's `platform_config.push_mode`, edited at
 * `/admin/platform` (docs/wiki/backlog.d/push-payloads-carry-nothing-for-google-and-apple.md).
 *
 * `full` sends today's payloads; `wake` sends a device whose binary declared it understands one a
 * content-free wake-up, and the device fetches the rest. Unlike calls and lives this switch is not
 * published by `GET /api/version`: no screen hides anything because of it, the push itself says
 * which shape it is. Spelled in four places, held together by `pushModesAgree.test.ts`.
 */
export type PushMode = 'full' | 'wake';

/** The two values, in the order the admin picker offers them. */
export const PUSH_MODES: readonly PushMode[] = ['full', 'wake'];
