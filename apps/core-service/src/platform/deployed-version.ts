import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The version this service was built as, or `null` when it cannot be read.
 *
 * NULL IS NOT `'0.0.0'`, AND KEEPING THEM APART IS THE WHOLE POINT OF THIS FILE. The reader that
 * used to live in `version.service.ts` returned `'0.0.0'` on failure, which is a real version and a
 * perfectly legitimate answer - so a caller could not tell "this build is 0.0.0" from "I could not
 * find out". That conflation is harmless while the value is only ever reported, and stops being
 * harmless the moment something DECIDES on it: a bound of the form "may not exceed the deployed
 * version" would, on an unreadable package.json, refuse every value above 0.0.0 - turning a failed
 * file read into a hard block on a legitimate administrative action.
 *
 * Callers that merely report the version keep their own default. Callers that decide must handle
 * `null` explicitly, and say so when they meet it.
 */
export function deployedVersion(): string | null {
  try {
    const pkgPath = join(__dirname, '..', '..', 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: string };
    return pkg.version ?? null;
  } catch {
    return null;
  }
}
