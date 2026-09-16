import { truncateLogIds } from './logTruncate';

describe('truncateLogIds', () => {
  it('tronque un UUID à 8 caractères + …', () => {
    expect(truncateLogIds('group=67fde7aa-94b5-4529-8798-883ef0faad42')).toBe('group=67fde7aa…');
  });

  it('tronque un userId 64-hex', () => {
    const id = 'd82cd2268993451edb547bdd7ff278447f6619f67d0d73a520897e54f0714df2';
    expect(truncateLogIds(`user=${id}`)).toBe('user=d82cd226…');
  });

  it('tronque la partie hex embarquée dans un device id composite', () => {
    const id = 'web-d82cd2268993451edb547bdd7ff278447f6619f67d0d73a520897e54f0714df2-mq8acpb6-u4dt';
    expect(truncateLogIds(id)).toBe('web-d82cd226…-mq8acpb6-u4dt');
  });

  it('laisse intacts les hex courts (epochs, couleurs)', () => {
    expect(truncateLogIds('epoch=42 color=#151B2C n=1af3')).toBe('epoch=42 color=#151B2C n=1af3');
  });

  it('tronque plusieurs identifiants dans la même ligne', () => {
    expect(
      truncateLogIds('group=67fde7aa-94b5-4529-8798-883ef0faad42 sender=ab12cd34ef56ab78')
    ).toBe('group=67fde7aa… sender=ab12cd34…');
  });
});

/**
 * A SECOND-RESOLUTION CLOCK CANNOT MEASURE A ONE-SECOND BUDGET.
 *
 * The production export of 2026-09-16 puts four consecutive boot steps on the same `[13:32:42]`,
 * and every line that did not come through `appendLog` carried no time at all - so the two halves
 * of a boot could not be placed against each other. Both are the same defect: the stamp belonged on
 * the ONE console seam, not on one of the callers.
 */
describe('installConsoleIdTruncation stamps every line', () => {
  let printed: unknown[][];
  let original: typeof console.log;
  let install: () => void;

  beforeEach(async () => {
    vi.resetModules();
    printed = [];
    original = console.log;
    console.log = (...args: unknown[]) => void printed.push(args);
    const mod = await import('./logTruncate');
    install = mod.installConsoleIdTruncation;
    install();
  });

  afterEach(() => {
    console.log = original;
  });

  it('puts a millisecond wall clock and an offset since navigation in front of the line', () => {
    console.log('Initialised in WEB mode (WASM)');

    expect(printed).toHaveLength(1);
    const [prefix, ...rest] = printed[0];
    expect(prefix).toMatch(/^\[\d{2}:\d{2}:\d{2}\.\d{3} \+\d+ms\]$/);
    expect(rest).toEqual(['Initialised in WEB mode (WASM)']);
  });

  it('passes the prefix as its OWN argument, so an object stays inspectable', () => {
    // Concatenating onto the first argument would turn `console.log(obj)` into text, and the
    // harness captures this stream over CDP - `[blocks.isBlockedWith] Object` is a line whose
    // subject cannot be recovered, which is the defect `Log.ts` exists to avoid.
    const payload = { epoch: 42 };
    console.log(payload);

    expect(printed[0]).toHaveLength(2);
    expect(printed[0][1]).toBe(payload);
  });

  it('still condenses identifiers, which is the job it already had', () => {
    console.log('user=d82cd2268993451edb547bdd7ff278447f6619f67d0d73a520897e54f0714df2');
    expect(printed[0][1]).toBe('user=d82cd226…');
  });

  it('wraps once however often it is called', () => {
    // A second wrap would put two prefixes on every line for the rest of the session, and the guard
    // is a module-level flag - so this has to call it again rather than trust the flag by reading it.
    install();
    install();
    console.log('once');
    expect(printed[0]).toHaveLength(2);
  });
});
