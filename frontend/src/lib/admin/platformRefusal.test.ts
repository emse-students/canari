import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { PLATFORM_ERROR_CODES, readPlatformRefusal } from './platformRefusal';

const here = dirname(fileURLToPath(import.meta.url));
const CORE_PLATFORM_SERVICE = resolve(
  here,
  '../../../../apps/core-service/src/platform/platform.service.ts'
);

describe('platform-admin refusal codes', () => {
  // The two sides compile separately, so a renamed code would type-check in both and silently fall
  // back to the generic error on screen. The producer's declaration is read and compared.
  it('match the codes core-service declares', () => {
    const source = readFileSync(CORE_PLATFORM_SERVICE, 'utf8');
    for (const [key, value] of Object.entries(PLATFORM_ERROR_CODES)) {
      expect(source).toContain(`${key}: '${value}'`);
    }
  });

  it('reads the code and the saved config out of a refusal body', async () => {
    vi.spyOn(console, 'debug').mockImplementation(() => {});
    const res = new Response(
      JSON.stringify({
        statusCode: 502,
        code: PLATFORM_ERROR_CODES.WITHHELD_RELEASE_INCOMPLETE,
        message: 'english prose',
        config: { paymentProvider: 'lydia' },
      }),
      { status: 502 }
    );
    expect(await readPlatformRefusal<{ paymentProvider: string }>(res)).toEqual({
      code: 'WITHHELD_RELEASE_INCOMPLETE',
      config: { paymentProvider: 'lydia' },
    });
  });

  it('CONTROL: an untyped or non-JSON refusal has no code', async () => {
    vi.spyOn(console, 'debug').mockImplementation(() => {});
    const plain = new Response(JSON.stringify({ statusCode: 400, message: 'x' }), { status: 400 });
    expect(await readPlatformRefusal(plain)).toEqual({ code: null, config: null });
    expect(await readPlatformRefusal(new Response('down', { status: 500 }))).toEqual({
      code: null,
      config: null,
    });
  });
});
