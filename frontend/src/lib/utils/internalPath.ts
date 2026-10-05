/**
 * Types a path COMPUTED AT RUNTIME as one of this app's own, so it can go through `resolve()`.
 *
 * Every navigation is written `goto(resolve(...))` / `href={resolve(...)}` (the oxvelte rule
 * `svelte/no-navigation-without-resolve` is on), which is what makes the app survive being served
 * under a base path: `resolve` prefixes `base`. A literal route type-checks against the route table
 * by itself; a path that arrives as a `string` - a `returnTo`, a deep link, a tab's target - cannot,
 * and this is the ONE place that asserts it.
 *
 * WHY THE TYPE IS `'/'`: `resolve`'s parameter type is a distributed union over every route, which
 * no single union-typed value satisfies, so the assertion names one member - the root, which has
 * no parameters, so `resolve` treats the value as a plain pathname. It asserts and does not check:
 * `resolve` throws on a path that does not start with `/`, and `goto` refuses an external URL.
 */
export function internalPath(path: string): '/' {
  return path as '/';
}
