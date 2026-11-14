import 'reflect-metadata';
import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { CreatePostDto } from './dto/post.dto';

/**
 * A post's `associationId` is a uuid or absent. A malformed one used to pass the input check as a
 * plain string and reach a uuid column, where Postgres refused it: the author got a 500 for their
 * own request's error. The pipe below is the one `main.ts` installs, so what it throws is what the
 * route answers.
 */
const pipe = new ValidationPipe({ whitelist: true, transform: true });
const read = (body: object) =>
  pipe.transform(body, { type: 'body', metatype: CreatePostDto }) as Promise<CreatePostDto>;

const ASSOCIATION = 'b3c1f0aa-0000-4000-8000-000000000001';

describe('CreatePostDto.associationId', () => {
  it('accepts a post with no association, and one naming a uuid', async () => {
    await expect(read({ markdown: 'hello' })).resolves.toMatchObject({ markdown: 'hello' });
    await expect(read({ markdown: 'hello', associationId: ASSOCIATION })).resolves.toMatchObject({
      associationId: ASSOCIATION,
    });
  });

  it.each([
    ['a word', 'not-a-uuid'],
    ['a uuid with a character missing', ASSOCIATION.slice(0, -1)],
    ['an empty string', ''],
    ['a number', 42],
  ])('refuses %s with a 400 naming the field', async (_label, associationId) => {
    const refusal = await read({ markdown: 'hello', associationId }).catch((e: unknown) => e);
    expect(refusal).toBeInstanceOf(BadRequestException);
    expect((refusal as BadRequestException).getResponse()).toMatchObject({
      message: expect.arrayContaining([expect.stringContaining('associationId')]),
    });
  });
});
