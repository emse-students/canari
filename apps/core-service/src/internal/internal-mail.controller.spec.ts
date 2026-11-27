import { Logger, NotFoundException, ForbiddenException } from '@nestjs/common';
import { InternalMailController, MAIL_ACCOUNT_UNKNOWN } from './internal-mail.controller';

/**
 * THE MAIL RELAY'S ELIGIBILITY SOURCE (docs/wiki/mail-client-transport.md#eligibility): the class
 * stored at sign-in, read from the row - no MiConnect call, no address.
 */
describe('InternalMailController', () => {
  const SECRET = 'internal-test-secret';
  let previous: string | undefined;

  beforeAll(() => {
    previous = process.env.INTERNAL_SECRET;
    process.env.INTERNAL_SECRET = SECRET;
  });
  afterAll(() => {
    if (previous === undefined) delete process.env.INTERNAL_SECRET;
    else process.env.INTERNAL_SECRET = previous;
  });

  function controller(row: { id: string; mailClass?: string | null } | null) {
    const findOne = jest.fn().mockResolvedValue(row);
    return { mail: new InternalMailController({ findOne } as never), findOne };
  }

  it.each([
    ['student', 'student'],
    ['staff', 'staff'],
    [null, null],
  ])('answers the stored class %s', async (stored, answered) => {
    const { mail, findOne } = controller({ id: 'user-1', mailClass: stored });
    await expect(mail.mailClass('user-1', SECRET)).resolves.toEqual({ mailClass: answered });
    // The column and the id, nothing else of the row.
    expect(findOne).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      select: { id: true, mailClass: true },
    });
  });

  it('answers 404 for an id with no row', async () => {
    const err = await controller(null)
      .mail.mailClass('user-1', SECRET)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotFoundException);
    expect((err as NotFoundException).getResponse()).toEqual(
      expect.objectContaining({ code: MAIL_ACCOUNT_UNKNOWN })
    );
  });

  it('answers an unknown stored value as not offered, and accuses it', async () => {
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    await expect(
      controller({ id: 'user-1', mailClass: 'admin' }).mail.mailClass('user-1', SECRET)
    ).resolves.toEqual({ mailClass: null });
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  it('refuses a caller without the internal secret', async () => {
    await expect(
      controller({ id: 'user-1', mailClass: 'student' }).mail.mailClass('user-1', 'wrong')
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});
