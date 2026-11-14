import 'reflect-metadata';
import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { CreatePostDto } from './dto/post.dto';

/**
 * A post's `associationId` and `attachedFormId` are each a uuid or absent. A malformed one used to
 * pass the input check as a plain string and reach a uuid column, where Postgres refused it: the
 * author got a 500 for their own request's error. The pipe below is the one `main.ts` installs, so what it throws is what the
 * route answers.
 */
const pipe = new ValidationPipe({ whitelist: true, transform: true });
const read = (body: object) =>
  pipe.transform(body, { type: 'body', metatype: CreatePostDto }) as Promise<CreatePostDto>;

const ID = 'b3c1f0aa-0000-4000-8000-000000000001';
/** A version 7 uuid: the check is on the shape, not on one version. */
const ID_V7 = '0193a5b0-7c1e-7a3b-9f00-000000000001';

describe.each(['associationId', 'attachedFormId'] as const)('CreatePostDto.%s', (field) => {
  it('accepts a post without it, with null, and one naming a uuid of any version', async () => {
    await expect(read({ markdown: 'hello' })).resolves.toMatchObject({ markdown: 'hello' });
    await expect(read({ markdown: 'hello', [field]: null })).resolves.toBeDefined();
    for (const id of [ID, ID_V7]) {
      await expect(read({ markdown: 'hello', [field]: id })).resolves.toMatchObject({
        [field]: id,
      });
    }
  });

  it.each([
    ['a word', 'not-a-uuid'],
    ['a uuid with a character missing', ID.slice(0, -1)],
    ['an empty string', ''],
    ['a number', 42],
  ])('refuses %s with a 400 naming the field', async (_label, value) => {
    const refusal = await read({ markdown: 'hello', [field]: value }).catch((e: unknown) => e);
    expect(refusal).toBeInstanceOf(BadRequestException);
    expect((refusal as BadRequestException).getResponse()).toMatchObject({
      message: expect.arrayContaining([expect.stringContaining(field)]),
    });
  });
});
