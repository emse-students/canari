/**
 * Which deployed environment this build was made for.
 *
 * WHY IT IS A BUILD-TIME FACT AND NOT AN API CALL. The dev environment carries a FULL copy of
 * production's database, so it is indistinguishable from production on screen - same users, same
 * communities, same posts. A banner saying so has to be up before anything is rendered and has to
 * stay up when the API is unreachable, which rules out learning it from `/api/version`.
 *
 * WHY IT IS NOT DERIVED FROM THE HOSTNAME. The same reasoning that moved the refresh cookie's
 * attributes onto an explicit variable: a deployment's identity is configuration, and a hostname
 * check is a rule that has to be edited every time a name is added. It also cannot answer for the
 * mobile app, where the origin is `tauri://localhost` in every environment.
 *
 * The value is `VITE_DEPLOY_ENVIRONMENT`, written by the pipeline that builds the image. UNSET MEANS
 * PRODUCTION, and that direction is deliberate: the failure mode of a missing variable is then a
 * missing banner on a non-production environment, which is visible to whoever is looking at it,
 * rather than a banner on production, which is visible to every member.
 */

/** A deployment that is NOT production, and must say so on screen. */
export type NonProductionEnvironment = 'development';

/**
 * The environment label this build was given, or `null` for production.
 *
 * Only known labels are returned. An unrecognised value is treated as production rather than shown
 * raw, because the banner's text is localised and a value nobody planned for has no translation.
 */
export function deployEnvironment(): NonProductionEnvironment | null {
  const raw = import.meta.env.VITE_DEPLOY_ENVIRONMENT?.trim().toLowerCase();
  if (!raw || raw === 'production' || raw === 'prod') return null;
  if (raw === 'development' || raw === 'dev') return 'development';
  return null;
}

/** Whether this build must carry the permanent "test environment" banner. */
export function isNonProductionDeployment(): boolean {
  return deployEnvironment() !== null;
}
