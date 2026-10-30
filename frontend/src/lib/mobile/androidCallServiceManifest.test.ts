import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { NATIVE_CALL_EVENT } from './androidCallService';

/**
 * THE ONGOING-CALL SERVICE (WP-C-BG-A) IS DECLARED EXACTLY WHERE CALLS ARE PLACED.
 *
 * A foreground-service type is a Play Console declaration: declared in a build no user can call
 * from, it is the Play twin of the `voip` mode App Review refused (calls.md, the switches table); used
 * and undeclared, the service cannot start. So the declaration lives in the main manifest and follows
 * `CALLS_COMPILED` (it moved there from a gradle-merged overlay at the flip of 2026-10-22). Asserted as AGREEMENT with `CALLS_COMPILED` (an in-app call's need, so NOT the native ring's
 * `CALLS_NATIVE_RING_COMPILED`), as `callsCompiled.test.ts` does for the other switches, so the
 * revival commit fails here only if it forgets this one.
 *
 * The bridge is a handful of names on each side of the WebView - the event, the interface, its methods -
 * and nothing compiles them against each other; read here as text. This proves what is written,
 * never what runs: the Mi 9T reading in calls.md is what proves the second.
 */
const here = dirname(fileURLToPath(import.meta.url));
const APP = resolve(here, '../../../src-tauri/gen/android/app');
const KOTLIN = resolve(APP, 'src/main/java/fr/emse/canari');
const read = (path: string) => readFileSync(path, 'utf8');

const features = read(resolve(here, '../features.ts'));
const mainManifest = read(resolve(APP, 'src/main/AndroidManifest.xml'));
const gradle = read(resolve(APP, 'build.gradle.kts'));
const bridgeKt = read(resolve(KOTLIN, 'CallBridge.kt'));
const pureKt = read(resolve(KOTLIN, 'call/OngoingCall.kt'));
const activityKt = read(resolve(KOTLIN, 'MainActivity.kt'));
const bridgeTs = read(resolve(here, 'androidCallService.ts'));
const layout = read(resolve(here, '../../routes/+layout.svelte'));

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

  it('the service is a non-exported microphone service, with both permissions, in the main manifest', () => {
    expect(declares(mainManifest, 'FOREGROUND_SERVICE')).toBe(COMPILED);
    // phoneCall needs a ConnectionService or MANAGE_OWN_CALLS this app does not have (see the service).
    expect(declares(mainManifest, 'FOREGROUND_SERVICE_PHONE_CALL')).toBe(false);
    const service = tags(mainManifest, 'service').filter((t) =>
      t.includes('CallForegroundService')
    );
    expect(service).toHaveLength(COMPILED ? 1 : 0);
    if (COMPILED) {
      expect(service[0]).toContain('android:name="fr.emse.canari.CallForegroundService"');
      expect(service[0]).toContain('android:foregroundServiceType="microphone"');
      expect(service[0]).toContain('android:exported="false"');
    }
  });

  it('video calls add no camera foreground service: the camera is OFF while the app is hidden', () => {
    // 1.5.2 ships video, and `CallService.installBackgroundHandler` turns the camera off when the
    // activity announces the background (`canari:foreground` false - the Android WebView never fires
    // `visibilitychange`), capture stopped, and on again on return, so the service never holds the
    // camera (pinned in CallService.p2p.test.ts, "on Android, where the WebView stays visible"). A `camera` type would be a second Play declaration for a use the app does not make.
    expect(declares(mainManifest, 'FOREGROUND_SERVICE_CAMERA')).toBe(false);
    expect(mainManifest).not.toMatch(/foregroundServiceType="[^"]*camera/);
  });

  it('the Android workflow reads the BUILT manifests and fails on a service where calls are not placed', () => {
    const workflow = read(resolve(here, '../../../../.github/workflows/android.yml'));
    expect(workflow).toContain(
      '- name: Check the built manifests carry the call service exactly when calls are compiled'
    );
    expect(workflow).toContain('android\\.permission\\.FOREGROUND_SERVICE_MICROPHONE');
    expect(workflow).toContain('fr\\.emse\\.canari\\.CallForegroundService');
    expect(workflow).toContain('cannot read CALLS_COMPILED');
  });

  it('gradle merges no overlay: the declaration is the main manifest alone', () => {
    expect(gradle).not.toContain('src/calls/');
    expect(gradle).not.toContain('VITE_DEPLOY_ENVIRONMENT');
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

  it('the four methods the page calls are the four the interface exposes', () => {
    for (const method of [
      'start(json: String)',
      'update(json: String)',
      'stop(callId: String, reason: String)',
      'pageLoaded()',
    ]) {
      expect(bridgeKt).toMatch(
        // Every metacharacter, backslash included, so the signature is matched as literal text.
        new RegExp(`@JavascriptInterface\\s+fun ${method.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`)
      );
    }
    for (const method of [
      'start(json: string): void;',
      'update(json: string): void;',
      'stop(callId: string, reason: string): void;',
      'pageLoaded(): void;',
    ]) {
      expect(bridgeTs).toContain(method);
    }
  });

  it('the call id is one field name both ways: read from start/update, echoed on every event', () => {
    expect(bridgeKt).toContain('o.optString("callId", "")');
    expect(bridgeKt).toContain('detail.put("callId", callId)');
    expect(bridgeTs).toContain('JSON.stringify({ ...spec, callId })');
    expect(bridgeTs).toContain("typeof d.callId !== 'string'");
  });

  it('the two refusal codes are the same words on both sides', () => {
    expect(pureKt).toContain('OFF_SCREEN("off-screen")');
    expect(pureKt).toContain('REFUSED("refused")');
    expect(bridgeTs).toContain("export type NativeCallRefusal = 'off-screen' | 'refused';");
  });

  it('the start is a plain startService: a refused startForeground is a logged stop, never an fgRequired crash', () => {
    expect(bridgeKt).toContain('context.startService(');
    expect(bridgeKt).not.toMatch(/\.startForegroundService\(/);
  });

  it('a resume answers a pending off-screen refusal', () => {
    expect(activityKt).toContain('CallBridge.onActivityResumed()');
  });

  it('a destroyed activity takes the call service down with its page, and a loaded page releases an orphan', () => {
    expect(activityKt).toContain('CallForegroundService.stopForPageGone(this)');
    expect(layout).toMatch(
      /if \(isAndroidTauriRuntime\(\)\) releaseCallServiceOfPreviousPage\(window\);/
    );
  });
});
