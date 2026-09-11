import { renderLegacyCotisationSql } from './legacy-cotisation-sql';

describe('renderLegacyCotisationSql', () => {
  const row = (matchKey: string, sourceLabel: string, metadata: Record<string, unknown> = {}) => ({
    matchKey,
    sourceLabel,
    metadata,
  });

  it('resolves the association by slug rather than carrying an id, so one file is correct on either estate', () => {
    const sql = renderLegacyCotisationSql({
      rows: [row('dupont|marie|2024', 'DUPONT Marie (2024)')],
      slug: 'cercle',
      variantKey: 'avec-alcool',
      batch: 'cercle-legacy-2026-09',
    });

    expect(sql).toContain("CROSS JOIN associations a\n WHERE a.slug = 'cercle'");
    // The two estates run the same schema with different ids; an interpolated uuid would apply
    // cleanly against the wrong one and attach every row to another association.
    expect(sql).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
  });

  it('doubles an apostrophe in a name, which is the whole of the escaping under standard_conforming_strings', () => {
    const sql = renderLegacyCotisationSql({
      rows: [row("d'arcy|jean|2023", "D'ARCY Jean (2023)")],
      slug: 'bde',
      variantKey: null,
      batch: 'bde-legacy-2026-09',
    });

    expect(sql).toContain("('d''arcy|jean|2023', 'D''ARCY Jean (2023)'");
    // A single unescaped apostrophe would terminate the literal and turn the rest of a 1400-row
    // VALUES list into syntax, which is the failure this test exists for.
    expect(sql.match(/'/g)!.length % 2).toBe(0);
  });

  it('leaves a backslash alone, because it is an ordinary character and not an escape', () => {
    const sql = renderLegacyCotisationSql({
      rows: [row('a|b|2020', 'BACK\\SLASH Test (2020)')],
      slug: 'bde',
      variantKey: null,
      batch: 'b',
    });

    expect(sql).toContain("'BACK\\SLASH Test (2020)'");
  });

  it('writes the base tier as a NULL the catalogue check compares with IS NOT DISTINCT FROM', () => {
    const sql = renderLegacyCotisationSql({
      rows: [row('a|b|2020', 'A B (2020)')],
      slug: 'bde',
      variantKey: null,
      batch: 'b',
    });

    // `= NULL` is never true, so the BDE's base tier would look absent and the load would refuse
    // itself. The null-safe comparison is the only one that answers this question.
    expect(sql).toContain('"variantKey" IS NOT DISTINCT FROM NULL::varchar');
    expect(sql).toContain("RAISE EXCEPTION '% has no % tier', 'bde', 'base'");
  });

  it('names the tier in the catalogue check when there is one', () => {
    const sql = renderLegacyCotisationSql({
      rows: [row('a|b|2020', 'A B (2020)')],
      slug: 'cercle',
      variantKey: 'avec-alcool',
      batch: 'b',
    });

    expect(sql).toContain(`"variantKey" IS NOT DISTINCT FROM 'avec-alcool'::varchar`);
  });

  it('keeps the load idempotent on the partial index, so a re-run stages nothing twice', () => {
    const sql = renderLegacyCotisationSql({
      rows: [row('a|b|2020', 'A B (2020)')],
      slug: 'bde',
      variantKey: null,
      batch: 'b',
    });

    expect(sql).toContain(
      `ON CONFLICT ("matchKey", "associationId") WHERE "claimedByUserId" IS NULL DO NOTHING`
    );
  });

  it('renders every row, one VALUES tuple each, with the metadata as jsonb', () => {
    const sql = renderLegacyCotisationSql({
      rows: [
        row('a|b|2020', 'A B (2020)', { source: 'cercle-legacy-db', legacyUserId: 7 }),
        row('c|d|2021', 'C D (2021)'),
      ],
      slug: 'cercle',
      variantKey: 'avec-alcool',
      batch: 'cercle-legacy-2026-09',
    });

    expect(sql).toContain(`'{"source":"cercle-legacy-db","legacyUserId":7}'`);
    expect(sql).toContain('v.metadata::jsonb');
    // `  ('` and not `  (`: the INSERT's own column list opens the same way and is not a row.
    expect(sql.split('\n').filter((l) => l.startsWith("  ('")).length).toBe(2);
  });

  it('renders the preconditions and nothing else for an empty load, rather than invalid SQL', () => {
    const sql = renderLegacyCotisationSql({
      rows: [],
      slug: 'bde',
      variantKey: null,
      batch: 'b',
    });

    expect(sql).toContain('RAISE EXCEPTION');
    expect(sql).not.toContain('INSERT INTO');
    // An empty VALUES list is a syntax error, so the guard has to be the absence of the statement.
    expect(sql).not.toContain('VALUES');
    expect(sql.trimEnd().endsWith('COMMIT;')).toBe(true);
  });

  it('opens and closes exactly one transaction', () => {
    const sql = renderLegacyCotisationSql({
      rows: [row('a|b|2020', 'A B (2020)')],
      slug: 'bde',
      variantKey: null,
      batch: 'b',
    });

    expect(sql.match(/^BEGIN;$/gm)!.length).toBe(1);
    expect(sql.match(/^COMMIT;$/gm)!.length).toBe(1);
  });

  it('says in the file itself that it must not be committed', () => {
    const sql = renderLegacyCotisationSql({
      rows: [row('a|b|2020', 'A B (2020)')],
      slug: 'bde',
      variantKey: null,
      batch: 'b',
    });

    // The repository is public and these files name ~5600 people. The warning travels with the
    // artefact because that is where whoever opens it will be.
    expect(sql).toContain('THIS FILE NAMES REAL PEOPLE');
  });
});
