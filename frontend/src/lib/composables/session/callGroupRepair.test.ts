import { repairStuckCallGroup, setCallGroupRepair } from './callGroupRepair';

vi.mock('$lib/utils/sessionLog', () => ({ appendLog: vi.fn() }));

/** A CALL'S STUCK GROUP IS REPAIRED BY THE SESSION THAT OWNS IT, AND BY NO OTHER. */
describe('repairStuckCallGroup', () => {
  afterEach(() => setCallGroupRepair(null));

  it("asks the registered session's repair", () => {
    const repair = vi.fn();
    setCallGroupRepair(repair);
    repairStuckCallGroup('group-1');
    expect(repair).toHaveBeenCalledWith('group-1');
  });

  it('after a sign-out removed it, asks nobody and says so', async () => {
    const repair = vi.fn();
    setCallGroupRepair(repair);
    setCallGroupRepair(null);
    repairStuckCallGroup('group-1');
    expect(repair).not.toHaveBeenCalled();
    const { appendLog } = await import('$lib/utils/sessionLog');
    expect(vi.mocked(appendLog)).toHaveBeenCalledWith(
      expect.stringContaining('no session to repair it')
    );
  });
});
