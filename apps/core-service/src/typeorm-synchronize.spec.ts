import { typeormSynchronize } from './typeorm-synchronize';

/**
 * The schema of a deployed estate changes only through a migration, so `synchronize` is an explicit
 * opt-in that production refuses. One spec for the three byte-identical copies (declared
 * duplicates pin them together).
 */
describe('typeormSynchronize', () => {
  it('is OFF when the flag is unset, whatever NODE_ENV says', () => {
    expect(typeormSynchronize({ NODE_ENV: 'development' })).toBe(false);
    expect(typeormSynchronize({ NODE_ENV: 'test' })).toBe(false);
    expect(typeormSynchronize({})).toBe(false);
  });

  it('is OFF when the flag is 0 or empty', () => {
    expect(typeormSynchronize({ TYPEORM_SYNCHRONIZE: '0', NODE_ENV: 'development' })).toBe(false);
    expect(typeormSynchronize({ TYPEORM_SYNCHRONIZE: '', NODE_ENV: 'development' })).toBe(false);
  });

  it('is ON only when the flag is 1 outside production', () => {
    expect(typeormSynchronize({ TYPEORM_SYNCHRONIZE: '1', NODE_ENV: 'development' })).toBe(true);
    expect(typeormSynchronize({ TYPEORM_SYNCHRONIZE: '1', NODE_ENV: 'test' })).toBe(true);
  });

  it('refuses to start with the flag on next to NODE_ENV=production', () => {
    expect(() => typeormSynchronize({ TYPEORM_SYNCHRONIZE: '1', NODE_ENV: 'production' })).toThrow(
      /refusing to start/
    );
  });

  it('refuses a value it does not know rather than guessing', () => {
    for (const flag of ['true', 'yes', ' 1']) {
      expect(() =>
        typeormSynchronize({ TYPEORM_SYNCHRONIZE: flag, NODE_ENV: 'development' })
      ).toThrow(/must be 1, 0 or unset/);
    }
  });

  it('no longer turns on because NODE_ENV is missing - the old rule did', () => {
    expect(typeormSynchronize({ NODE_ENV: undefined })).toBe(false);
  });
});
