import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  STUDENTS_ONLY_ASSOCIATION_TYPES,
  STUDENTS_ONLY_NOT_OFFERED,
  studentsOnlyOffered,
} from './studentsOnly';

describe('the "Entre étudiants" switch offer', () => {
  it('equals libs/contracts/students-only.json, the server reads the same file', () => {
    const contract = JSON.parse(
      readFileSync(join(process.cwd(), '..', 'libs', 'contracts', 'students-only.json'), 'utf8')
    );
    expect([...STUDENTS_ONLY_ASSOCIATION_TYPES]).toEqual(contract.types);
    expect(STUDENTS_ONLY_NOT_OFFERED).toBe(contract.code);
  });

  it('is offered to an association and a list, never an institution nor a personal post', () => {
    expect(studentsOnlyOffered('association')).toBe(true);
    expect(studentsOnlyOffered('list')).toBe(true);
    expect(studentsOnlyOffered('institution')).toBe(false);
    expect(studentsOnlyOffered(undefined)).toBe(false);
    expect(studentsOnlyOffered(null)).toBe(false);
  });
});
