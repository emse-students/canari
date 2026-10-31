import { describe, expect, it, vi } from 'vitest';
import { closeConversationAdmission } from './admissionClassify';

/**
 * The app closes what it positively knows to be a conversation, and nothing else: a key group closed
 * by mistake would refuse every newcomer of a community.
 */
const mls = (overrides: Record<string, unknown> = {}) =>
  ({
    isDistributionGroup: vi.fn().mockReturnValue(false),
    getAdmissionPolicy: vi.fn().mockResolvedValue('unclassified'),
    setAdmissionPolicy: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }) as any;

describe('closeConversationAdmission', () => {
  it('closes a conversation nobody classified', async () => {
    const service = mls();

    expect(await closeConversationAdmission(service, 'g1')).toBe(true);
    expect(service.setAdmissionPolicy).toHaveBeenCalledWith('g1', 'closed');
  });

  it('never closes a key group, whatever it says it is', async () => {
    const service = mls({ isDistributionGroup: vi.fn().mockReturnValue(true) });

    expect(await closeConversationAdmission(service, 'key-group')).toBe(false);
    expect(service.setAdmissionPolicy).not.toHaveBeenCalled();
    expect(service.getAdmissionPolicy).not.toHaveBeenCalled();
  });

  it('writes nothing for a conversation that is already closed', async () => {
    const service = mls({ getAdmissionPolicy: vi.fn().mockResolvedValue('closed') });

    expect(await closeConversationAdmission(service, 'g1')).toBe(true);
    expect(service.setAdmissionPolicy).not.toHaveBeenCalled();
  });

  it('asks once per group per service, because a save happens per message', async () => {
    const service = mls();

    await closeConversationAdmission(service, 'g1');
    await closeConversationAdmission(service, 'g1');
    await closeConversationAdmission(service, 'g1');

    expect(service.getAdmissionPolicy).toHaveBeenCalledTimes(1);
  });

  it('does not share its memory between two services: a new session starts from nothing', async () => {
    const first = mls();
    const second = mls();

    await closeConversationAdmission(first, 'g1');
    await closeConversationAdmission(second, 'g1');

    expect(second.setAdmissionPolicy).toHaveBeenCalledWith('g1', 'closed');
  });

  it('leaves the group unclassified and says so when the service fails, and retries next time', async () => {
    const log = vi.fn();
    const service = mls({
      setAdmissionPolicy: vi.fn().mockRejectedValueOnce(new Error('not ready')),
    });

    expect(await closeConversationAdmission(service, 'g1', log)).toBe(false);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('stays unclassified'));

    expect(await closeConversationAdmission(service, 'g1', log)).toBe(true);
  });
});
