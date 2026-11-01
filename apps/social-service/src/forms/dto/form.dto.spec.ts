import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { CreateFormDto, FormItemDto } from './form.dto';
import { SUPPORTED_QUESTION_TYPES } from './question-types';

/** Collects the failing property names, so an assertion says WHICH constraint rejected. */
const failedProps = (dto: object): string[] => validateSync(dto).map((error) => error.property);

/** A minimal valid form carrying one item of the given type and the given base price. */
const buildForm = (type: string, basePrice: number): CreateFormDto =>
  plainToInstance(CreateFormDto, {
    title: 'T',
    basePrice,
    currency: 'EUR',
    items: [{ label: 'Q', required: false, type }],
  });

const buildItem = (type: string): FormItemDto =>
  plainToInstance(FormItemDto, { label: 'Q', required: false, type });

/** A single_choice item carrying one option, to drive the nested FormOptionDto validation. */
const buildItemWithOption = (priceModifier: number): FormItemDto =>
  plainToInstance(FormItemDto, {
    label: 'Q',
    required: false,
    type: 'single_choice',
    options: [{ label: 'A', priceModifier }],
  });

describe('FormItemDto.type allowlist', () => {
  it('accepts every canonical question type', () => {
    for (const type of SUPPORTED_QUESTION_TYPES) {
      expect(failedProps(buildItem(type))).toEqual([]);
    }
  });

  it('rejects an unlisted type (the dev junk `text`/`select` a hand-posted call sent)', () => {
    expect(failedProps(buildItem('text'))).toEqual(['type']);
    expect(failedProps(buildItem('select'))).toEqual(['type']);
  });

  it('rejects the `single` alias on a write - it is read-only back-compat for `dropdown`', () => {
    expect(failedProps(buildItem('single'))).toEqual(['type']);
  });

  it('rejects an empty type', () => {
    expect(failedProps(buildItem(''))).toEqual(['type']);
  });
});

describe('CreateFormDto.basePrice is integer cents', () => {
  it('accepts an integer number of cents', () => {
    expect(failedProps(buildForm('short_text', 1050))).toEqual([]);
    expect(failedProps(buildForm('short_text', 0))).toEqual([]);
  });

  it('rejects a fractional value - there is no fractional cent', () => {
    expect(failedProps(buildForm('short_text', 10.5))).toEqual(['basePrice']);
  });

  it('rejects a negative value', () => {
    expect(failedProps(buildForm('short_text', -1))).toEqual(['basePrice']);
  });
});

describe('FormOptionDto.priceModifier is integer cents', () => {
  it('accepts an integer number of cents', () => {
    expect(failedProps(buildItemWithOption(250))).toEqual([]);
    expect(failedProps(buildItemWithOption(0))).toEqual([]);
  });

  it('rejects a fractional value - there is no fractional cent', () => {
    // The failure is reported on the nested `options` property of the item.
    expect(failedProps(buildItemWithOption(2.5))).toEqual(['options']);
  });

  it('rejects a negative value - the service ignores it, so it would be a phantom discount', () => {
    expect(failedProps(buildItemWithOption(-100))).toEqual(['options']);
  });
});

/**
 * The backend allowlist is a deliberate copy of the frontend's canonical list across the package
 * boundary; this test is the gate that forbids the two hand-kept lists from drifting. It reads the
 * frontend source, parses the `value:` entries of `QUESTION_TYPES`, and asserts the backend set
 * equals it EXACTLY. The `value: string` of the interface has no quotes, so the quoted-value regex
 * matches only the array entries.
 */
describe('SUPPORTED_QUESTION_TYPES mirrors the frontend canonical list', () => {
  it('equals QUESTION_TYPES in frontend/src/lib/forms/questionTypes.ts exactly', () => {
    const source = readFileSync(
      resolve(__dirname, '../../../../../frontend/src/lib/forms/questionTypes.ts'),
      'utf8'
    );
    const frontendTypes = [...source.matchAll(/value:\s*('[^']+'|"[^"]+")/g)].map((m) =>
      m[1].slice(1, -1)
    );

    expect(frontendTypes.length).toBe(SUPPORTED_QUESTION_TYPES.length);
    expect([...frontendTypes].sort()).toEqual([...SUPPORTED_QUESTION_TYPES].sort());
  });
});
