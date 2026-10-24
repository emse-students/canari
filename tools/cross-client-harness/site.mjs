/**
 * THE ONLY DOOR TO `SITE` AND `ORIGIN`, AND IT REFUSES PRODUCTION BEFORE ANYTHING READS THEM.
 *
 * `SITE` (in the machine-local `names.mjs`) is the one line that says where the campaign runs. Every
 * module that needs to know it - to navigate, to build an APK, to match a tab, to read a server -
 * imports it from HERE, and this module's evaluation throws `EstateRefusedError` when it names
 * anything but the local estate or dev. ES modules evaluate their imports first, so an entry point
 * pointed at production dies before its own first line runs: not a check each runner must remember,
 * a property of where the value comes from.
 *
 * `archive/estate-selftest.mjs` asserts that no other file imports `SITE` or `ORIGIN` from
 * `names.mjs`, so the door cannot be walked around by a new runner.
 */
import { ORIGIN as CONFIGURED_ORIGIN, SITE as CONFIGURED_SITE } from './names.mjs';
import { estateOf, refuseForeignOrigins } from './estate-target.mjs';

/** `'local'` or `'dev'`; any other `SITE` has already thrown. */
export const ESTATE = estateOf(CONFIGURED_SITE);

/** The campaign's estate, as an absolute URL. See `names.example.mjs`. */
export const SITE = CONFIGURED_SITE;

/**
 * Each device's page origin. Web devices are on `SITE`; a Tauri app is on its own scheme. A web
 * origin naming ANOTHER estate than `SITE` is refused too, through the same allowlist: a device
 * pointed at production while `SITE` says dev is production driven under dev's name.
 */
export const ORIGIN = refuseForeignOrigins(CONFIGURED_ORIGIN, ESTATE);
