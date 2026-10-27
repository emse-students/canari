import { describe, expect, it } from 'vitest';
import { columnsHidden } from './columns';

describe('columnsHidden (D44)', () => {
  it('hides the columns level for exactly one column', () => {
    expect(columnsHidden([{ id: 'a' }])).toBe(true);
  });

  it('shows it for none (a space created before WP-R1) and for two or more', () => {
    expect(columnsHidden([])).toBe(false);
    expect(columnsHidden([{ id: 'a' }, { id: 'b' }])).toBe(false);
  });
});
