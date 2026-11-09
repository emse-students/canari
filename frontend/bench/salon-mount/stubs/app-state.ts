/** `$app/state` outside SvelteKit: the page the bench stands on, and nothing navigating. */
export const page = {
  url: new URL(typeof location === 'undefined' ? 'https://bench.invalid/' : location.href),
  params: {} as Record<string, string>,
  route: { id: null as string | null },
  state: {} as Record<string, unknown>,
  data: {} as Record<string, unknown>,
  status: 200,
  error: null,
  form: null,
};

/** No navigation is ever in flight on the bench page. */
export const navigating = { current: null };

/** The bench never checks for a new deployment. */
export const updated = { current: false, check: async () => false };
