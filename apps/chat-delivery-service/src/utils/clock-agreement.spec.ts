import { CLOCK_AGREEMENT_BOUND_MS, checkDatabaseClockAgreement } from './clock-agreement';

/**
 * THE TWO CLOCKS EVERY ARRIVAL IS READ FROM (review of #2800): a time-zone offset between this
 * process and Postgres is accused at ERROR at boot, and nothing about the check can stop the boot.
 */
describe('checkDatabaseClockAgreement', () => {
  const logger = () => ({ log: jest.fn(), error: jest.fn() });
  const answering = (db: unknown) => ({ query: jest.fn().mockResolvedValue([{ db }]) });

  it('says nothing at ERROR when the two clocks agree', async () => {
    const l = logger();

    await expect(checkDatabaseClockAgreement(answering(new Date()), l)).resolves.toBe('agree');

    expect(l.error).not.toHaveBeenCalled();
    expect(l.log).toHaveBeenCalledWith(
      expect.stringContaining('[CLOCK] this process and Postgres agree')
    );
  });

  it('accuses a time-zone offset - an hour, as Europe/Paris against UTC reads', async () => {
    const l = logger();

    await expect(
      checkDatabaseClockAgreement(answering(new Date(Date.now() - 3_600_000)), l)
    ).resolves.toBe('disagree');

    expect(l.error).toHaveBeenCalledTimes(1);
    expect(l.error.mock.calls[0][0]).toContain('disagree by -3600 s');
  });

  it('tolerates an honest skew under the bound', async () => {
    const l = logger();

    await checkDatabaseClockAgreement(
      answering(new Date(Date.now() + CLOCK_AGREEMENT_BOUND_MS / 2)),
      l
    );

    expect(l.error).not.toHaveBeenCalled();
  });

  it('never throws: a failed read or an unreadable answer is said at ERROR as unknown', async () => {
    const failing = logger();
    await expect(
      checkDatabaseClockAgreement(
        { query: jest.fn().mockRejectedValue(new Error('down')) },
        failing
      )
    ).resolves.toBe('unreadable');
    expect(failing.error.mock.calls[0][0]).toContain('could not run');

    const garbled = logger();
    await expect(checkDatabaseClockAgreement(answering(null), garbled)).resolves.toBe('unreadable');
    expect(garbled.error.mock.calls[0][0]).toContain('NOT known');
  });
});
