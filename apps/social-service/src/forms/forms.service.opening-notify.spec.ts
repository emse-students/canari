import { ConflictException } from '@nestjs/common';
import { Logger } from '@nestjs/common';
import { FORM_OPENING_NOTIFIES, FormsService } from './forms.service';
import { FORM_DRAFT, FORM_PUBLISHED } from './form-status';

/**
 * MOVING A PUBLISHED FORM'S OPENING EARLIER PUSHES EVERYONE WHO ASKED (owner, 2026-11-17, (B)): the
 * move is refused `409 FORM_OPENING_NOTIFIES` with the count unless the editor confirmed it. Later,
 * a draft, or nobody waiting goes through. The guard is private, read here on its own.
 */
describe('FormsService - an earlier opening asks first when people asked to be told', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  const at = (minutes: number) => new Date(Date.UTC(2026, 10, 20, 12, minutes)).toISOString();

  const guard = (untold: number) => {
    const db: any = {
      query: jest.fn(() =>
        Promise.resolve(Array.from({ length: untold }, () => ({ '?column?': 1 })))
      ),
    };
    const service = Object.create(FormsService.prototype) as any;
    service.logger = new Logger('test');
    const run = (
      form: { status: string; opensAt: Date | null },
      raw: string | null | undefined,
      confirmed = false
    ) =>
      service.assertEarlierOpeningConfirmed(
        { id: 'form-1', ...form },
        raw,
        confirmed,
        db
      ) as Promise<void>;
    return { run, db };
  };
  const published = (minutes: number | null) => ({
    status: FORM_PUBLISHED as string,
    opensAt: minutes === null ? null : new Date(at(minutes)),
  });

  it('refuses an earlier opening naming how many are waiting', async () => {
    const { run } = guard(3);
    const refusal = await run(published(60), at(0)).catch((e) => e);
    expect(refusal).toBeInstanceOf(ConflictException);
    expect(refusal.getResponse()).toMatchObject({ code: FORM_OPENING_NOTIFIES, askers: 3 });
  });

  it('refuses clearing the opening (open at once) the same way', async () => {
    const { run } = guard(1);
    await expect(run(published(60), null)).rejects.toBeInstanceOf(ConflictException);
    await expect(run(published(60), undefined)).rejects.toBeInstanceOf(ConflictException);
  });

  it('lets the editor confirm it', async () => {
    const { run } = guard(3);
    await expect(run(published(60), at(0), true)).resolves.toBeUndefined();
  });

  it('lets a later or unchanged opening through without reading anybody', async () => {
    const { run, db } = guard(3);
    await expect(run(published(60), at(120))).resolves.toBeUndefined();
    await expect(run(published(60), at(60))).resolves.toBeUndefined();
    expect(db.query).not.toHaveBeenCalled();
  });

  it('lets an earlier opening through when nobody is waiting', async () => {
    const { run } = guard(0);
    await expect(run(published(60), at(0))).resolves.toBeUndefined();
  });

  it('never asks about a draft, nor a form that had no opening to move earlier', async () => {
    const { run, db } = guard(3);
    await expect(
      run({ status: FORM_DRAFT, opensAt: new Date(at(60)) }, at(0))
    ).resolves.toBeUndefined();
    await expect(run(published(null), at(0))).resolves.toBeUndefined();
    expect(db.query).not.toHaveBeenCalled();
  });
});
