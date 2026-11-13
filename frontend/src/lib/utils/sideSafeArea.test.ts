import { sideSafePadding } from './sideSafeArea';

describe('sideSafePadding', () => {
  it('pads each side by the published inset, the engine env() under it, plus the extra', () => {
    expect(sideSafePadding('0.75rem')).toBe(
      'padding-left: calc(var(--safe-area-inset-left, env(safe-area-inset-left, 0px)) + 0.75rem); ' +
        'padding-right: calc(var(--safe-area-inset-right, env(safe-area-inset-right, 0px)) + 0.75rem);'
    );
  });

  it('adds nothing by default', () => {
    expect(sideSafePadding()).toContain('+ 0px)');
  });
});
