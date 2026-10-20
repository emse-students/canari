import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { NATIVE_CALL_EVENT } from './androidCallService';

/**
 * THE ONGOING-CALL SERVICE (WP-C-BG-A) IS DECLARED EXACTLY WHERE CALLS ARE PLACED.
 *
 * A foreground-service type is a Play Console declaration: declared in a build no user can call
 * from, it is the Play twin of the `voip` mode App Review refused (calls.md, the five switches); used
 * and undeclared, the service cannot start. So the declaration lives in `src/calls/AndroidManifest.xml`,
 * merged by `build.gradle.kts` only when `VITE_DEPLOY_ENVIRONMENT` is `development` - the fact that
 * turns `CALLS_ENABLED` on in the page - and moves into the main manifest the day `CALLS_COMPILED`
 * flips. Asserted as AGREEMENT with `CALLS_COMPILED`, as `callsCompiled.test.ts` does for the five
 * switches, so the revival commit fails here only if it forgets this one.
 *
 * The bridge is three names on each side of the WebView - the event, the interface, its methods -
 * and nothing compiles them against each other; read here as text. This proves what is written,
 * never what runs: the Mi 9T reading in calls.md is what proves the second.
 */
const here = dirname(fileURLToPath(import.meta.url));
const APP = resolve(here, '../../../src-tauri/gen/android/app');
const KOTLIN = resolve(APP, 'src/main/java/fr/emse/canari');
const read = (path: string) => readFileSync(path, 'utf8');

const features = read(resolve(here, '../features.ts'));
const mainManifest = read(resolve(APP, 'src/main/AndroidManifest.xml'));
const callsManifest = read(resolve(APP, 'src/calls/AndroidManifest.xml'));
const gradle = read(resolve(APP, 'build.gradle.kts'));
const bridgeKt = read(resolve(KOTLIN, 'CallBridge.kt'));
const activityKt = read(resolve(KOTLIN, 'MainActivity.kt'));
const bridgeTs = read(resolve(here, 'androidCallService.ts'));

const COMPILED = /export const CALLS_COMPILED = true;/.test(features);

/** Every tag of `name` in an XML text, so a comment naming a permission is never read as one. */
const tags = (xml: string, name: string) => xml.match(new RegExp(`<${name}\\s[^>]*/?>`, 'g')) ?? [];
const declares = (xml: string, permission: string) =>
  tags(xml, 'uses-permission').some((t) => t.includes(`android.permission.${permission}"`));

describe('the ongoing-call foreground service declaration', () => {
  it('the main manifest declares the service and its permission exactly when CALLS_COMPILED is true', () => {
    expect(tags(mainManifest, 'uses-permission').length, 'no permission parsed').toBeGreaterThan(0);
    expect(declares(mainManifest, 'FOREGROUND_SERVICE_MICROPHONE')).toBe(COMPILED);
    expect(mainManifest.includes('CallForegroundService"')).toBe(COMPILED);
  });

  it('the calls overlay declares a non-exported microphone service and both permissions', () => {
    expect(declares(callsManifest, 'FOREGROUND_SERVICE')).toBe(true);
    expect(declares(callsManifest, 'FOREGROUND_SERVICE_MICROPHONE')).toBe(true);
    // phoneCall needs a ConnectionService or MANAGE_OWN_CALLS this app does not have (see the service).
    expect(declares(callsManifest, 'FOREGROUND_SERVICE_PHONE_CALL')).toBe(false);
    const service = tags(callsManifest, 'service');
    expect(service).toHaveLength(1);
    expect(service[0]).toContain('android:name="fr.emse.canari.CallForegroundService"');
    expect(service[0]).toContain('android:foregroundServiceType="microphone"');
    expect(service[0]).toContain('android:exported="false"');
  });

  it('gradle merges the overlay on the same fact that turns CALLS_ENABLED on', () => {
    expect(features).toMatch(
      /CALLS_ENABLED\s*=\s*CALLS_COMPILED \|\| deployEnvironment\(\) === 'development'/
    );
    expect(gradle).toContain('System.getenv("VITE_DEPLOY_ENVIRONMENT")');
    expect(gradle).toContain('val on = value == "development"');
    for (const type of ['debug', 'release']) {
      expect(gradle).toContain(
        `sourceSets.getByName("${type}").manifest.srcFile("src/calls/AndroidManifest.xml")`
      );
    }
  });
});

describe('the bridge, both sides of the WebView', () => {
  it('one event name', () => {
    expect(bridgeKt).toContain(`const val EVENT = "${NATIVE_CALL_EVENT}"`);
  });

  it('canariCall is registered only when the service is in the merged manifest', () => {
    expect(activityKt).toMatch(
      /if \(CallBridge\.serviceDeclared\(this\)\) \{\s*webView\.addJavascriptInterface\(CallBridge\.JsInterface\(applicationContext\), "canariCall"\)/
    );
    expect(bridgeTs).toContain('canariCall?: AndroidCallBridge');
  });

  it('the three methods the page calls are the three the interface exposes', () => {
    for (const method of ['start(json: String)', 'update(json: String)', 'stop(reason: String)']) {
      expect(bridgeKt).toMatch(
        new RegExp(`@JavascriptInterface\\s+fun ${method.replace(/[()]/g, '\\$&')}`)
      );
    }
    for (const method of [
      'start(json: string): void;',
      'update(json: string): void;',
      'stop(reason: string): void;',
    ]) {
      expect(bridgeTs).toContain(method);
    }
  });

  it('a destroyed activity takes the call service down with its page', () => {
    expect(activityKt).toContain('CallForegroundService.stopForPageGone(this)');
  });
});
