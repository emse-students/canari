/// <reference types="jest" />

/**
 * `POST media/internal/form-file` DATES THE UPLOAD FROM THE MEMBER'S OWN TOKEN, verified here
 * (docs/wiki/services/media-service.md#an-erased-owner-registers-nothing-2026-11-24).
 *
 * social-service forwards the member's bearer token; media-service reads its `iat` only once the
 * signature, the expiry and the subject check out. Anything else - no token, a token that does not
 * verify, one naming another account - leaves the upload undated, which the erased-owner record
 * judges old. No number another service states is ever believed.
 */
import * as crypto from 'crypto';
import { MediaController } from './media.controller';
import type { MediaService } from './media.service';

const JWT = 'form-file-dating-secret';
const INTERNAL = 'internal-secret';
const IAT = 1_900_000_000;

/** `iat: null` mints a token without one. */
function token(
  sub: string,
  secret = JWT,
  iat: number | null = IAT,
  extra: Record<string, unknown> = {}
): string {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const head = b64({ alg: 'HS256', typ: 'JWT' });
  const claims = { sub, exp: 4_000_000_000, ...extra };
  const body = b64(iat === null ? claims : { ...claims, iat });
  const sig = crypto.createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${sig}`;
}

function build() {
  const dated: Array<number | undefined> = [];
  const svc = {
    uploadFormFile: jest.fn(async (_data: Buffer, _owner: string, issuedAt?: number) => {
      dated.push(issuedAt);
      return { mediaId: 'm', sizeBytes: 1 };
    }),
  };
  const controller = new MediaController(svc as unknown as MediaService, {} as never, {} as never);
  const store = (authorization?: string) =>
    controller.uploadFormFile(
      { buffer: Buffer.from('%PDF-1.7'), size: 8 },
      { ownerId: 'alice' },
      INTERNAL,
      authorization
    );
  return { dated, store };
}

const prev = { jwt: process.env.JWT_SECRET, internal: process.env.INTERNAL_SECRET };
beforeAll(() => {
  process.env.JWT_SECRET = JWT;
  process.env.INTERNAL_SECRET = INTERNAL;
});
afterAll(() => {
  process.env.JWT_SECRET = prev.jwt;
  process.env.INTERNAL_SECRET = prev.internal;
});

describe('POST media/internal/form-file - the upload is dated by the verified member token', () => {
  it("reads the mint time of the uploader's own token", async () => {
    const { dated, store } = build();
    await store(`Bearer ${token('alice')}`);
    expect(dated).toEqual([IAT * 1000]);
  });

  it('dates it from a token that EXPIRED on the way: the request was authenticated when it arrived', async () => {
    const { dated, store } = build();
    await store(`Bearer ${token('alice', JWT, IAT, { exp: IAT + 60 })}`);
    expect(dated).toEqual([IAT * 1000]);
  });

  it('leaves it undated - judged old - when no token is forwarded', async () => {
    const { dated, store } = build();
    await store(undefined);
    expect(dated).toEqual([undefined]);
  });

  it('leaves it undated when the token does not verify, or names another account', async () => {
    const { dated, store } = build();
    await store(`Bearer ${token('alice', 'another-secret')}`);
    await store(`Bearer ${token('bob')}`);
    await store(`Bearer ${token('alice', JWT, null)}`);
    await store(`Bearer ${token('alice', JWT, IAT, { type: 'refresh' })}`);
    expect(dated).toEqual([undefined, undefined, undefined, undefined]);
  });
});
