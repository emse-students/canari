/**
 * `PATCH /api/posts/:postId/pin|unpin` names its space (WP-PIN): since floor `1.6.6` a body with no
 * `spaceId` is a 400 before the service runs, never a guess at the one space that fits
 * (docs/wiki/legacy-compatibility.md - the body-less shim went with that floor).
 */
import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { PinPostDto } from './post.dto';

const errorsOf = async (body: object) =>
  (await validate(plainToInstance(PinPostDto, body))).map((e) => e.property);

describe('PinPostDto', () => {
  it('accepts a named space', async () => {
    expect(await errorsOf({ spaceId: '00000000-0000-4000-8000-000000000001' })).toEqual([]);
  });

  it('refuses a body naming no space, or a space that is not a uuid', async () => {
    expect(await errorsOf({})).toEqual(['spaceId']);
    expect(await errorsOf({ spaceId: 'ismin' })).toEqual(['spaceId']);
  });
});
