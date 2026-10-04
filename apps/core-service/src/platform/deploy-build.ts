/**
 * The build identity of this deployment, or `null` when it was not given one.
 *
 * WHY IT IS SEPARATE FROM THE VERSION, AND MUST STAY SEPARATE. `version` is a field clients DECIDE
 * on: `compareSemver` parses it, `releaseTag` turns it into `vX.Y.Z`, and `getReleaseApkDownloadUrl`
 * builds a GitHub download URL out of it. Appending `+dev.<sha7>` to that field, which is how the
 * plan for the dev environment first described this, would have produced a download URL for the tag
 * `v0.14.15+dev.abc1234` - a release that does not exist - so the update prompt on a dev client
 * would have offered a 404. A build identity is REPORTING; a version is DECIDED on; and the two do
 * not belong in one string.
 *
 * `DEPLOY_BUILD` is written by the pipeline that deploys the environment - the commit it deployed,
 * short. Production leaves it unset, because production's version already names its content: it is
 * built from a tag. The dev environment is deployed from `main` on every push, so its version is
 * whatever the last release said and only the commit distinguishes two deployments of it.
 *
 * NO CLIENT MAY DECIDE ON THIS VALUE, which is why it is a plain string rather than a parsed shape.
 * The one server-side decision is {@link isDevEstate}, which only ever REFUSES something.
 */
export function deployBuild(): string | null {
  const raw = process.env.DEPLOY_BUILD?.trim();
  return raw ? raw : null;
}

/**
 * Whether this process is the DEV estate - the one fact the deployment already delivers: production
 * renders no `DEPLOY_BUILD` by decision, so a non-null build IS dev (see `docker-compose.dev.yml`).
 *
 * It exists for refusals that must hold on dev whatever else is configured, the profile edit above
 * all: dev and production share ONE MiConnect, so a dev write would change a real person. It is used
 * ONLY to refuse, and never alone - dev also holds no token, so losing this variable degrades to
 * "not configured" rather than to an edit.
 */
export function isDevEstate(): boolean {
  return deployBuild() !== null;
}
