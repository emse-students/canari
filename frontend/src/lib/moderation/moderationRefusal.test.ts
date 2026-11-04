import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { m } from '$lib/paraglide/messages';
import { ApiRefusalError } from '$lib/utils/apiRefusalError';
import { MODERATION_REFUSAL_CODES, describeModerationRefusal } from './moderationRefusal';

const here = dirname(fileURLToPath(import.meta.url));
const BDE_MODERATION = resolve(
  here,
  '../../../../apps/social-service/src/spaces/bde-moderation.ts'
);

describe('moderation refusal codes', () => {
  // The two sides compile separately, so a renamed code would type-check in both and silently fall
  // back to the generic line on screen. The producer's declaration is read and compared.
  it('match the codes social-service declares', () => {
    const source = readFileSync(BDE_MODERATION, 'utf8');
    for (const [key, value] of Object.entries(MODERATION_REFUSAL_CODES)) {
      expect(source).toContain(`export const ${key} = '${value}';`);
    }
  });

  it("words the owner's rule: an institution's or a BDE's content is the platform admin's", () => {
    vi.spyOn(console, 'debug').mockImplementation(() => {});
    const refusal = new ApiRefusalError(
      403,
      MODERATION_REFUSAL_CODES.MODERATION_RESERVED_TO_PLATFORM_ADMIN,
      'english prose'
    );
    expect(describeModerationRefusal(refusal)).toBe(
      m.moderation_refusal_reserved_to_platform_admin()
    );
    expect(
      describeModerationRefusal(new ApiRefusalError(403, 'MODERATION_OUT_OF_SCOPE', 'x'))
    ).toBe(m.moderation_refusal_out_of_scope());
    expect(describeModerationRefusal(new ApiRefusalError(403, 'MODERATOR_REQUIRED', 'x'))).toBe(
      m.moderation_refusal_moderator_required()
    );
  });

  it('CONTROL: an untyped refusal, another code or a transport failure has no sentence', () => {
    expect(describeModerationRefusal(new ApiRefusalError(403, null, 'x'))).toBeNull();
    expect(describeModerationRefusal(new ApiRefusalError(403, 'USER_BLOCKED', 'x'))).toBeNull();
    expect(describeModerationRefusal(new TypeError('Failed to fetch'))).toBeNull();
  });
});
