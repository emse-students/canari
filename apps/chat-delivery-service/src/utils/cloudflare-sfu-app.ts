/**
 * The Cloudflare Realtime SFU app this server proxies for a group call through `call_relay =
 * cloudflare` (WP-GC3): `CLOUDFLARE_SFU_APP_ID` and `CLOUDFLARE_SFU_APP_SECRET`, read from the
 * environment at each use (a redeploy that adds them needs no code path of its own), never cached,
 * never logged, never sent to a client.
 *
 * ONE reader for both consumers: `initiate` refuses a Cloudflare-relayed group call on a server
 * without the pair (`GROUP_CALL_RELAY_UNAVAILABLE`), and the proxy refuses every request the same
 * way - so the two can never disagree about whether the relay exists.
 */
export interface CloudflareSfuApp {
  appId: string;
  appSecret: string;
}

/**
 * The app's pair, or `null` when either half is absent or blank - a half-configured app is not an
 * app, and it is named by the caller's refusal, never guessed around.
 */
export function readCloudflareSfuApp(
  env: NodeJS.ProcessEnv = process.env
): CloudflareSfuApp | null {
  const appId = env.CLOUDFLARE_SFU_APP_ID?.trim();
  const appSecret = env.CLOUDFLARE_SFU_APP_SECRET?.trim();
  if (!appId || !appSecret) return null;
  return { appId, appSecret };
}

/** Which half of the pair is missing, for the ERROR line that names a misconfigured relay. */
export function missingCloudflareSfuHalves(env: NodeJS.ProcessEnv = process.env): string {
  const missing = [
    env.CLOUDFLARE_SFU_APP_ID?.trim() ? null : 'CLOUDFLARE_SFU_APP_ID',
    env.CLOUDFLARE_SFU_APP_SECRET?.trim() ? null : 'CLOUDFLARE_SFU_APP_SECRET',
  ].filter((name): name is string => name !== null);
  return missing.join(', ') || 'none';
}
