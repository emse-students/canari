import { Logger, ServiceUnavailableException } from '@nestjs/common';
import { frontendBaseUrl } from './frontend-url';

describe('frontendBaseUrl', () => {
  const previous = process.env.FRONTEND_URL;
  afterEach(() => {
    if (previous === undefined) delete process.env.FRONTEND_URL;
    else process.env.FRONTEND_URL = previous;
  });

  it('is the first origin of the list, without its trailing slash', () => {
    process.env.FRONTEND_URL = 'https://canari.example/ , https://old.example';
    expect(frontendBaseUrl()).toBe('https://canari.example');
  });

  it('refuses, never guesses, when the variable is unset or blank', () => {
    // The refusal is PROVOKED here, so its accusing log is asserted instead of printed.
    const logged = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    try {
      for (const value of [undefined, '', ' , x']) {
        if (value === undefined) delete process.env.FRONTEND_URL;
        else process.env.FRONTEND_URL = value;
        expect(() => frontendBaseUrl()).toThrow(ServiceUnavailableException);
      }
      expect(logged).toHaveBeenCalledTimes(3);
      expect(logged).toHaveBeenCalledWith(
        expect.stringContaining('[CONFIG] FRONTEND_URL is unset')
      );
    } finally {
      logged.mockRestore();
    }
  });
});
