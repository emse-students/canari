import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { CreateUserDto, UpdateUserDto } from './user.dto';

describe('UpdateUserDto text normalization', () => {
  it('preserves newlines and tabs in the multi-line bio', () => {
    const dto = plainToInstance(UpdateUserDto, {
      bio: 'Line one\nLine two\n\tIndented',
    });
    expect(dto.bio).toBe('Line one\nLine two\n\tIndented');
  });

  it('normalizes CRLF to LF and trims outer whitespace in the bio', () => {
    const dto = plainToInstance(UpdateUserDto, { bio: '  first\r\nsecond  ' });
    expect(dto.bio).toBe('first\nsecond');
  });

  it('still strips dangerous zero-width / bidi format chars from the bio', () => {
    // ZWSP = U+200B zero-width space, RLO = U+202E right-to-left override.
    const zwsp = String.fromCharCode(0x200b);
    const rlo = String.fromCharCode(0x202e);
    const dto = plainToInstance(UpdateUserDto, { bio: `a${zwsp}b${rlo}c` });
    expect(dto.bio).toBe('abc');
  });

  it('strips newlines from single-line name fields', () => {
    const dto = plainToInstance(CreateUserDto, {
      id: 'sub',
      firstName: 'Jean\nPaul',
    });
    expect(dto.firstName).toBe('JeanPaul');
  });
});
