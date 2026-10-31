import { violatesUniqueColumns } from './pg-errors';

/**
 * `violatesUniqueColumns` classifies a unique violation by the COLUMNS of the index the driver names,
 * read from the catalog - so the same column under any constraint name answers the same.
 */
describe('violatesUniqueColumns', () => {
  const violation = (constraint?: string, schema?: string) =>
    Object.assign(new Error('duplicate key'), { code: '23505', constraint, schema });
  const catalog = (cols: string[]) =>
    jest.fn(() => Promise.resolve(cols.map((attname) => ({ attname }))));

  it('answers true for the column, whatever the constraint is called, passing name and schema', async () => {
    const query = catalog(['slug']);

    expect(await violatesUniqueColumns(violation('any_name', 'public'), ['slug'], query)).toBe(
      true
    );
    expect(query).toHaveBeenCalledWith(expect.any(String), ['any_name', 'public']);
  });

  it('answers false for another column, or a wider index that merely includes it', async () => {
    expect(await violatesUniqueColumns(violation('x'), ['slug'], catalog(['name']))).toBe(false);
    expect(await violatesUniqueColumns(violation('x'), ['slug'], catalog(['slug', 'type']))).toBe(
      false
    );
  });

  it('reads nothing for an error that is not a unique violation, or names no constraint', async () => {
    const query = catalog(['slug']);

    expect(await violatesUniqueColumns(new Error('boom'), ['slug'], query)).toBe(false);
    expect(await violatesUniqueColumns(violation(undefined), ['slug'], query)).toBe(false);
    expect(query).not.toHaveBeenCalled();
  });
});
