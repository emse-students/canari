// Hands the bench account's PIN to the parent over stdout, for the bench to tap on the in-app keypad.
// It is read from the out-of-tree account file by the same helper the cross-client rig uses, and the
// parent never prints it. Nothing here CHANGES a PIN: the keypad only unlocks the local store.
import { accountFor } from '../cross-client-harness/accounts.mjs';

const pin = String(accountFor('owner').pin);
if (!/^\d{4,8}$/.test(pin)) throw new Error('the stored PIN is not 4-8 digits');
process.stdout.write(pin);
