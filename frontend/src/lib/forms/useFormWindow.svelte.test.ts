import { describe, expect, it } from 'vitest';
import { ApiRefusalError } from '$lib/utils/apiRefusalError';
import { useFormWindow } from './useFormWindow.svelte';

const refused = (code: string) => new ApiRefusalError(400, code, 'refused');

describe('useFormWindow', () => {
  it('reads the server state of the form, whatever the stored dates say', () => {
    const w = useFormWindow(() => ({ opensAt: '2099-01-01T00:00:00Z', windowState: 'open' }), 'T');
    expect(w.state).toBe('open');
    expect(w.notYet).toBe(false);
    expect(w.closed).toBe(false);
  });

  it('takes a typed refusal as the newer verdict, and ignores any other refusal', () => {
    const w = useFormWindow(() => ({ windowState: 'open' }), 'T');
    w.adopt(refused('FORM_FULL'));
    expect(w.state).toBe('open');
    w.adopt(new Error('boom'));
    expect(w.state).toBe('open');
    w.adopt(refused('FORM_CLOSED'));
    expect(w.closed).toBe(true);
    w.adopt(refused('FORM_NOT_OPEN_YET'));
    expect(w.notYet).toBe(true);
  });

  it('goes back to what the form says once cleared by a newer read', () => {
    const w = useFormWindow(() => ({ windowState: 'open' }), 'T');
    w.adopt(refused('FORM_CLOSED'));
    w.clear();
    expect(w.state).toBe('open');
  });
});
