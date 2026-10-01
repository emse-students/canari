/**
 * THE PHONE A ROW DRIVES, CHOSEN BY `CANARI_PHONE` - `phone.mjs` (Android, the default) or
 * `phone-ios.mjs` (the iPhone), behind ONE interface.
 *
 * A row switches by replacing `import * as phone from '../phone.mjs'` with
 * `import phone from '../phone-any.mjs'`, and still binds its phone by name (`I1` on the iPhone,
 * `A1` on Android) and still renews the push link first - the gates that check both
 * (`ports-selftest`, `transport-selftest`) read the row, not this file. Examples are deliberately not
 * written here as code: those gates would read them as a runner.
 *
 * A DEFAULT EXPORT OF THE CHOSEN MODULE'S NAMESPACE, so `phone.X` behaves exactly as the
 * `import * as phone from '../phone.mjs'` it replaces - live bindings included (`SERIAL` is a `let`).
 * With `CANARI_PHONE` unset, a row switched to this module drives the same Android code it always
 * did. `phone-ios-selftest.mjs` asserts the two modules export the same names with the same
 * sync/async shape, so a row written against one cannot call something the other lacks.
 */
import { phonePlatform } from './phone-platform.mjs';

const phone = phonePlatform() === 'ios' ? await import('./phone-ios.mjs') : await import('./phone.mjs');

export default phone;
