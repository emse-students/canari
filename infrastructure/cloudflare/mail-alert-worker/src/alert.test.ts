import { describe, expect, it, mock, spyOn } from 'bun:test';
import { HOOK_PATH, relayAlert, SECRET_HEADER, tokenOf, type AlertEnv } from './alert';

const TOKEN = '0123456789abcdef0123456789abcdef';
const DOMAIN = 'alerte.example.test';

spyOn(console, 'warn').mockImplementation(() => {});
spyOn(console, 'error').mockImplementation(() => {});

function env(over: Partial<AlertEnv> = {}, allowed = true): AlertEnv {
  return {
    TARGET_URL: 'https://estate.example.test/',
    ALERT_DOMAIN: DOMAIN,
    HOOK_SECRET: 's3cret',
    MAIL_ALERT_LIMITER: { limit: mock(async () => ({ success: allowed })) },
    ...over,
  };
}

describe('tokenOf', () => {
  it('takes the token of an alert address on this domain only', () => {
    expect(tokenOf(`n-${TOKEN}@${DOMAIN}`, DOMAIN)).toBe(TOKEN);
    expect(tokenOf(`N-${TOKEN.toUpperCase()}@ALERTE.example.test`, DOMAIN)).toBe(TOKEN);
    expect(tokenOf(`n-${TOKEN}@other.example.test`, DOMAIN)).toBeNull();
    expect(tokenOf(`x-${TOKEN}@${DOMAIN}`, DOMAIN)).toBeNull();
    expect(tokenOf(`n-${TOKEN}0@${DOMAIN}`, DOMAIN)).toBeNull();
    expect(tokenOf('nobody', DOMAIN)).toBeNull();
  });
});

describe('relayAlert', () => {
  it('posts the token ALONE, with the secret header', async () => {
    const fetcher = mock(async () => new Response('{}', { status: 200 }));
    expect(await relayAlert(`n-${TOKEN}@${DOMAIN}`, env(), fetcher as any)).toBe('posted');
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`https://estate.example.test${HOOK_PATH}`);
    expect(JSON.parse(init.body as string)).toEqual({ token: TOKEN });
    expect((init.headers as Record<string, string>)[SECRET_HEADER]).toBe('s3cret');
  });

  it('drops what is not an alert address, without posting', async () => {
    const fetcher = mock(async () => new Response('{}'));
    expect(await relayAlert('someone@example.test', env(), fetcher as any)).toBe('not_ours');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('rate-limits per token', async () => {
    const e = env({}, false);
    const fetcher = mock(async () => new Response('{}'));
    expect(await relayAlert(`n-${TOKEN}@${DOMAIN}`, e, fetcher as any)).toBe('rate_limited');
    expect(e.MAIL_ALERT_LIMITER.limit).toHaveBeenCalledWith({ key: TOKEN });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('a missing secret posts nothing', async () => {
    const fetcher = mock(async () => new Response('{}'));
    expect(await relayAlert(`n-${TOKEN}@${DOMAIN}`, env({ HOOK_SECRET: '' }), fetcher as any)).toBe(
      'misconfigured'
    );
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('a refusal and a transport failure are told apart', async () => {
    const refused = mock(async () => new Response('', { status: 401 }));
    expect(await relayAlert(`n-${TOKEN}@${DOMAIN}`, env(), refused as any)).toBe('refused');
    const down = mock(async () => {
      throw new Error('connect');
    });
    expect(await relayAlert(`n-${TOKEN}@${DOMAIN}`, env(), down as any)).toBe('unreachable');
  });
});

describe('the relay agrees with the estate, and its config holds nothing private', () => {
  const root = `${import.meta.dir}/../../../..`;

  it("the header and the path are the server's", async () => {
    const server = await Bun.file(
      `${root}/apps/chat-delivery-service/src/utils/mail-alert.ts`
    ).text();
    expect(server).toContain(`MAIL_ALERT_SECRET_HEADER = '${SECRET_HEADER}'`);
    const controller = await Bun.file(
      `${root}/apps/chat-delivery-service/src/controllers/mail-alert.controller.ts`
    ).text();
    expect(controller).toContain(`@Post('${HOOK_PATH.replace('/api/', '')}')`);
  });

  it('wrangler.toml names no account and no secret value', async () => {
    const toml = await Bun.file(`${import.meta.dir}/../wrangler.toml`).text();
    const lines = toml.split('\n').filter((l) => !l.trim().startsWith('#'));
    expect(lines.some((l) => /account_id|HOOK_SECRET|zone_id/i.test(l))).toBe(false);
    expect(toml).toContain('MAIL_ALERT_LIMITER');
  });
});
