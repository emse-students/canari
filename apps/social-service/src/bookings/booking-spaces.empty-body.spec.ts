import { ValidationPipe } from '@nestjs/common';
import { CreateResourceDto, CreateSpaceDto } from './dto/space.dto';

/**
 * An empty body on a create route is a typed 400 from the global pipe, never a request that
 * reaches the database with no name (a NOT NULL violation, answered 500).
 */
const pipe = new ValidationPipe({ whitelist: true, transform: true });

describe.each([
  ['CreateSpaceDto', CreateSpaceDto],
  ['CreateResourceDto', CreateResourceDto],
])('%s', (_label, metatype) => {
  it.each([
    ['{}', {}],
    ['undefined', undefined],
    ['an empty name', { name: '' }],
  ])('refuses %s with a 400', async (_what, body) => {
    await expect(pipe.transform(body, { type: 'body', metatype })).rejects.toMatchObject({
      status: 400,
    });
  });

  it('accepts a named body', async () => {
    await expect(
      pipe.transform({ name: 'Salle' }, { type: 'body', metatype })
    ).resolves.toMatchObject({
      name: 'Salle',
    });
  });
});
