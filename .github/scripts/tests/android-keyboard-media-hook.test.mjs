#!/usr/bin/env bun
/**
 * THE ANDROID WEBVIEW STILL HANDS ITS INPUT CONNECTION TO THE KEYBOARD MEDIA BRIDGE.
 *
 * WHAT IS AT RISK. A GIF committed by the soft keyboard (Gboard's GIF tab) reaches the app only if
 * the focused editor's `EditorInfo` advertises image MIME types and its `InputConnection` routes a
 * `commitContent` to a listener. `KeyboardMediaBridge.wrapInputConnection` does both - but only if
 * `RustWebView.onCreateInputConnection` calls it, and `RustWebView` is wry's class: the copy under
 * `gen/android/.../generated/` is REWRITTEN from wry's Kotlin template by wry's build.rs on every
 * Android build. The hook was written into that generated copy in July 2026 and the next
 * regeneration (`3614a79518`, 2026-07-25) erased it without a word: the bridge stayed, compiled,
 * was called by nothing, and Gboard answered "GIF non disponibles ici avec cette appli" for months.
 * The hook now lives in the vendored template, `patches/wry/src/android/kotlin/RustWebView.kt`.
 *
 * Nothing in CI runs the Android UI, so each fact is read from the SOURCE TEXT:
 *   - the template overrides `onCreateInputConnection` and returns the bridge's wrapper of the
 *     connection `super` made (not a fresh one, not the bare `super` result);
 *   - the tracked generated copy carries the same override (it is what a reader opens, and what
 *     the last build produced);
 *   - the generated class and the bridge share ONE package, since the template names the bridge
 *     unqualified;
 *   - the bridge still offers image MIME types and wraps through the compat layer.
 * Every predicate is also run against the shape that shipped broken (upstream wry's class, with no
 * override), which it must REJECT: a check that cannot fail on the defect it names proves nothing.
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(process.argv[2] ?? join(import.meta.dirname, '..', '..', '..'));
const TAURI = join(ROOT, 'frontend', 'src-tauri');
const TEMPLATE = join(TAURI, 'patches', 'wry', 'src', 'android', 'kotlin', 'RustWebView.kt');
const APP_JAVA = join(
  TAURI,
  'gen',
  'android',
  'app',
  'src',
  'main',
  'java',
  'fr',
  'emse',
  'canari'
);
const GENERATED = join(APP_JAVA, 'generated', 'RustWebView.kt');
const BRIDGE = join(APP_JAVA, 'KeyboardMediaBridge.kt');

let failures = 0;
const fail = (msg) => {
  failures++;
  console.log(`FAIL ${msg}`);
};
const ok = (msg) => console.log(`ok   ${msg}`);

/** The body of `override fun onCreateInputConnection(...)`, from its signature to its closing brace. */
function hookBody(source) {
  const lines = source.split('\n');
  const start = lines.findIndex((l) =>
    /^\s*override fun onCreateInputConnection\(\s*\w+\s*:\s*EditorInfo\s*\)\s*:\s*InputConnection\?\s*\{/.test(
      l
    )
  );
  if (start === -1) return null;
  const indent = lines[start].match(/^\s*/)[0];
  const end = lines.findIndex((l, i) => i > start && l === `${indent}}`);
  return end === -1 ? null : lines.slice(start, end + 1).join('\n');
}

/** The hook is there, imports what it names, and returns the bridge's wrapper of super's connection. */
function carriesHook(source) {
  const body = hookBody(source);
  if (body === null) return false;
  const param = body.match(/onCreateInputConnection\(\s*(\w+)/)[1];
  const ic = body.match(
    new RegExp(`val (\\w+) = super\\.onCreateInputConnection\\(${param}\\)`)
  )?.[1];
  return (
    /^import android\.view\.inputmethod\.EditorInfo$/m.test(source) &&
    /^import android\.view\.inputmethod\.InputConnection$/m.test(source) &&
    ic !== undefined &&
    new RegExp(`return KeyboardMediaBridge\\.wrapInputConnection\\(this, ${ic}, ${param}\\)`).test(
      body
    )
  );
}

/** Upstream wry 0.57.1's class tail, which is what a regeneration from an unpatched wry produces. */
const UPSTREAM = `import android.annotation.SuppressLint
import android.webkit.*

class RustWebView(context: Context, val initScripts: Array<String>, val id: String): WebView(context) {
    fun getCookies(url: String): String {
        val cookieManager = CookieManager.getInstance()
        return cookieManager.getCookie(url)
    }

    {{class-extension}}
}`;

/** A hook that calls super and drops the wrapper: compiles, and offers the keyboard nothing. */
const SUPER_ONLY = `import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputConnection
class RustWebView {
    override fun onCreateInputConnection(outAttrs: EditorInfo): InputConnection? {
        val ic = super.onCreateInputConnection(outAttrs)
        KeyboardMediaBridge.wrapInputConnection(this, ic, outAttrs)
        return ic
    }
}`;

const read = (path, label) => {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    fail(`cannot read ${label} (${error.message}) - nothing in it was checked`);
    return null;
  }
};

const template = read(TEMPLATE, 'patches/wry/src/android/kotlin/RustWebView.kt');
const generated = read(GENERATED, 'gen/android/.../generated/RustWebView.kt');
const bridge = read(BRIDGE, 'gen/android/.../KeyboardMediaBridge.kt');

if (template !== null) {
  if (carriesHook(template))
    ok('the wry template overrides onCreateInputConnection and returns the bridge wrapper');
  else
    fail(
      'patches/wry/src/android/kotlin/RustWebView.kt has no onCreateInputConnection returning ' +
        'KeyboardMediaBridge.wrapInputConnection(this, ic, outAttrs) - a keyboard GIF is refused ' +
        '(docs/wiki/frontend/modules/chat.md#android-keyboard-media-commitcontent)'
    );
}

if (generated !== null) {
  if (carriesHook(generated)) ok('the tracked generated RustWebView carries the same hook');
  else
    fail(
      'gen/android/.../generated/RustWebView.kt has no hook: it was produced from a wry without ' +
        'the patch - rebuild Android (wry build.rs rewrites it from patches/wry) and commit it'
    );
}

const packageOf = (source) => source?.match(/^package\s+([\w.]+)\s*$/m)?.[1];
if (generated !== null && bridge !== null) {
  const a = packageOf(generated);
  const b = packageOf(bridge);
  if (a !== undefined && a === b)
    ok(`RustWebView and KeyboardMediaBridge share package ${a}, so the unqualified name resolves`);
  else
    fail(
      `RustWebView is in package '${a}' and KeyboardMediaBridge in '${b}' - the hook cannot resolve`
    );
}

if (bridge !== null) {
  if (
    /fun wrapInputConnection\(\s*webView: WebView,\s*ic: InputConnection\?,\s*editorInfo: EditorInfo,?\s*\)/.test(
      bridge
    ) &&
    /EditorInfoCompat\.setContentMimeTypes\(editorInfo, MIME_TYPES\)/.test(bridge) &&
    /"image\/gif"/.test(bridge) &&
    /InputConnectionCompat\.createWrapper\(webView, ic, editorInfo\)/.test(bridge)
  )
    ok('the bridge offers image/gif and wraps the connection through the compat layer');
  else fail('KeyboardMediaBridge.wrapInputConnection no longer offers image MIME types or wraps');
}

for (const [name, shape] of [
  ['upstream wry (no override)', UPSTREAM],
  ['an override that drops the wrapper', SUPER_ONLY],
]) {
  if (carriesHook(shape)) fail(`the hook check accepts ${name} - it proves nothing`);
  else ok(`the hook check rejects ${name}`);
}

console.log(failures === 0 ? '\nthe keyboard media hook holds' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
