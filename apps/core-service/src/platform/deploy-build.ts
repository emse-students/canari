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
 * NOTHING MAY DECIDE ON THIS VALUE, which is why it is a plain string rather than a parsed shape.
 */
export function deployBuild(): string | null {
  const raw = process.env.DEPLOY_BUILD?.trim();
  return raw ? raw : null;
}
