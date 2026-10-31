import {
  KeystoreKeyUnavailableError,
  MlsStateLoadUntypedError,
  mlsStateLoadErrorOf,
} from './mlsStateLoadError';
import { MlsStateVerdictError } from './mlsStateSeal';

/**
 * `mlsStateLoadErrorOf` is the ONE place a boundary's `{ code, message }` (`StateLoadRefusal` in
 * `mls-core`) becomes a type. It reads `code` and nothing else: a message naming a code is not one.
 */
describe('mlsStateLoadErrorOf', () => {
  let error: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    error = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it.each([
    'STATE_ALTERED',
    'STATE_KEY_MISMATCH',
    'STATE_UNDECRYPTABLE',
    'IDENTITY_MISMATCH',
  ] as const)('types the verdict code %s as MlsStateVerdictError, from the field', (code) => {
    const typed = mlsStateLoadErrorOf({ code, message: 'whatever the text says' });
    expect(typed).toBeInstanceOf(MlsStateVerdictError);
    expect((typed as MlsStateVerdictError).code).toBe(code);
    expect((typed as MlsStateVerdictError).refusal).toBeNull();
    expect(error).not.toHaveBeenCalled();
  });

  it('types an empty keystore as KeystoreKeyUnavailableError', () => {
    const typed = mlsStateLoadErrorOf({ code: 'KEYSTORE_KEY_UNAVAILABLE', message: 'no key' });
    expect(typed).toBeInstanceOf(KeystoreKeyUnavailableError);
    expect(error).not.toHaveBeenCalled();
  });

  it('leaves a null code untyped, whatever its message names, with ONE warning and no accusation of the boundary', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const typed = mlsStateLoadErrorOf({ code: null, message: 'STATE_ALTERED: a sentence' });
    expect(typed).toBeInstanceOf(MlsStateLoadUntypedError);
    expect(typed).not.toBeInstanceOf(MlsStateVerdictError);
    expect(error).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('does not type');
  });

  it('accuses a code outside the closed set - a bindings mismatch, never a verdict', () => {
    const typed = mlsStateLoadErrorOf({ code: 'SOMETHING_NEW', message: 'x' });
    expect(typed).toBeInstanceOf(MlsStateLoadUntypedError);
    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0][0])).toContain('outside the closed set');
  });

  it.each([
    ['an Error naming a code (the old string shape)', new Error('STATE_ALTERED: v1 tag failed')],
    ['a bare string naming a code', 'IDENTITY_MISMATCH: u:a vs u:b'],
    ['an object without a message', { code: 'STATE_ALTERED' }],
    ['undefined', undefined],
  ])('accuses a rejection outside the { code, message } contract: %s', (_name, rejection) => {
    const typed = mlsStateLoadErrorOf(rejection);
    expect(typed).toBeInstanceOf(MlsStateLoadUntypedError);
    expect(typed).not.toBeInstanceOf(MlsStateVerdictError);
    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0][0])).toContain('outside its { code, message } contract');
  });
});
