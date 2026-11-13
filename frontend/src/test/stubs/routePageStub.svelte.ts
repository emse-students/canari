/**
 * REACTIVE route params for a page test that navigates between two ids of the SAME route:
 * SvelteKit reuses the component, and only a reactive `params` lets the test drive what a real
 * navigation drives. The test's `$app/state` mock reads `params` through a getter on this.
 */
export const routeParams = $state({ current: { id: 'f1' } as Record<string, string> });
