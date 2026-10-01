### Fixed - the login flatness test strips comments without a regex CodeQL flags

Code-scanning alert 2544 (incomplete multi-character sanitization) named the single-pass comment regex in `LoginForm.flat.test.ts`; it now scans for the delimiters.
