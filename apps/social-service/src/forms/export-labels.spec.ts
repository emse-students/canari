import { parseExportLabels } from './export-labels';

/**
 * The export's words arrive as a query parameter, so they arrive as an UNTRUSTED STRING.
 *
 * What matters is that nothing here ever substitutes a word of its own: a client that sends no
 * labels, or a broken set, is refused. The alternative is the English that was the defect, written
 * into a file that looks perfectly correct to whoever generated it.
 */
describe('parseExportLabels', () => {
  const valid = {
    date: 'Date',
    firstName: 'Prenom',
    lastName: 'Nom de famille',
    amount: 'Montant paye',
    status: 'Statut',
    statuses: { free: 'Gratuit' },
  };

  it('accepts a complete set', () => {
    expect(parseExportLabels(JSON.stringify(valid))).toEqual(valid);
  });

  it('refuses an absent parameter rather than defaulting to anything', () => {
    expect(() => parseExportLabels(undefined)).toThrow(/required/);
    expect(() => parseExportLabels('')).toThrow(/required/);
  });

  it('refuses a parameter that is not JSON, or not an object', () => {
    expect(() => parseExportLabels('{nope')).toThrow(/valid JSON/);
    expect(() => parseExportLabels('"a string"')).toThrow(/must be an object/);
    expect(() => parseExportLabels('null')).toThrow(/must be an object/);
  });

  it('names the header it is missing', () => {
    const { lastName: _dropped, ...missing } = valid;
    expect(() => parseExportLabels(JSON.stringify(missing))).toThrow(/"lastName"/);
    expect(() => parseExportLabels(JSON.stringify({ ...valid, date: '' }))).toThrow(/"date"/);
  });

  it('refuses a status map that is not one', () => {
    expect(() => parseExportLabels(JSON.stringify({ ...valid, statuses: [] }))).toThrow(
      /"statuses"/
    );
    expect(() => parseExportLabels(JSON.stringify({ ...valid, statuses: { free: 3 } }))).toThrow(
      /status "free"/
    );
  });
});
