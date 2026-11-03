#!/usr/bin/env bun
/**
 * THE VENDORED wry STILL CARRIES THE MAIN-PIPE FIXES PLAY'S REPORTS ASKED FOR.
 *
 * WHAT IS AT RISK. `frontend/src-tauri/patches/wry` is a fork rebased BY HAND whenever upstream
 * releases (`vendored-upstream-report.sh` asks for it). The `CANARI PATCH` hunks in
 * `src/android/main_pipe.rs` and `src/android/binding.rs` are Android-only and run nowhere in CI:
 * every gate here compiles the Android code and none executes it. So a rebase that takes the new
 * upstream file and forgets a hunk builds, passes, ships - and brings back, silently:
 *   - ANR f51255a5a831e715b4fc8d976e87be11: a BOUNDED channel the main thread both sends into
 *     (`onWebviewDestroy`) and alone drains - a main-thread send into a full channel parks the only
 *     thread that could empty it; and the same deadlock one step removed, a BLOCKING wake write;
 *   - crash e3697bc4ad55d069ebb94d3d4a528c34: a panic inside the looper callback, which aborts the
 *     process - from `get_webview` unwrapping a destroyed activity, or from a reply `unwrap`ped
 *     after its requester's `recv_timeout` gave up;
 *   - a drain that unregisters itself for the rest of the process: on ONE failed JNI call (`?` in
 *     `recv`), on an EINTR read, silently;
 *   - a Java exception left pending by a message that did not fail, poisoning the next one;
 *   - a drain with no bound, which does not terminate while other threads keep sending.
 * Each is a fact about the SOURCE TEXT, so this reads the text. The device behaviour is owed on real
 * hardware: docs/wiki/device-verification.md#wmp-the-wry-main-pipe-after-an-activity-destroy---owed-on-android.
 *
 * Every predicate is also run against the UPSTREAM shape of the same code, which it must REJECT: a
 * check that cannot fail on the defect it names proves nothing.
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(process.argv[2] ?? join(import.meta.dirname, '..', '..', '..'));
const TAURI = join(ROOT, 'frontend', 'src-tauri');
const ANDROID = join(TAURI, 'patches', 'wry', 'src', 'android');

let failures = 0;
const fail = (msg) => {
  failures++;
  console.log(`FAIL ${msg}`);
};
const ok = (msg) => console.log(`ok   ${msg}`);

/** The text of one `fn <name>` - from its signature to the first line that closes it at its indent. */
function fnBody(source, name) {
  const lines = source.split('\n');
  const start = lines.findIndex((l) => new RegExp(`\\bfn ${name}\\b`).test(l));
  if (start === -1) return null;
  const indent = lines[start].match(/^\s*/)[0];
  const end = lines.findIndex((l, i) => i > start && l === `${indent}}`);
  return lines.slice(start, end === -1 ? undefined : end + 1).join('\n');
}

/** A top-level `static <name>`, up to the first column-0 line ending in `;` (rustfmt's shape). */
function staticInit(source, name) {
  const lines = source.split('\n');
  const start = lines.findIndex((l) => new RegExp(`^(pub )?static ${name}\\b`).test(l));
  if (start === -1) return null;
  const end = lines.findIndex((l, i) => i >= start && /^\S.*;\s*$/.test(l));
  return lines.slice(start, end === -1 ? undefined : end + 1).join('\n');
}

/** `source` with the body of `fn <name>` cut out, so a predicate can say "nowhere else". */
function without(source, name) {
  const body = fnBody(source, name);
  return body === null ? source : source.replace(body, '');
}

const PREDICATES = [
  {
    file: 'main_pipe.rs',
    what: 'the main-thread channel is unbounded',
    holds: (s) => {
      const init = staticInit(s, 'CHANNEL');
      return init !== null && /\bunbounded\b/.test(init) && !/\bbounded\s*\(/.test(init);
    },
    upstream: `static CHANNEL: LazyLock<(
  Sender<(ActivityId, WebViewMessage)>,
  Receiver<(ActivityId, WebViewMessage)>,
)> = LazyLock::new(|| bounded(8));`,
  },
  {
    file: 'main_pipe.rs',
    what: "the wake pipe's write end is made non-blocking",
    holds: (s) => {
      const init = staticInit(s, 'MAIN_PIPE');
      return init !== null && /O_NONBLOCK/.test(init) && /pipe\[1\]/.test(init);
    },
    upstream: `pub static MAIN_PIPE: LazyLock<[OwnedFd; 2]> = LazyLock::new(|| {
  let mut pipe: [RawFd; 2] = Default::default();
  unsafe { libc::pipe(pipe.as_mut_ptr()) };
  unsafe { pipe.map(|fd| OwnedFd::from_raw_fd(fd)) }
});`,
  },
  {
    file: 'main_pipe.rs',
    what: 'get_webview answers None for a destroyed activity, and says so once per activity',
    holds: (s) => {
      const body = fnBody(s, 'get_webview');
      return (
        body !== null &&
        !/\.get\(&activity_id\)\s*\.unwrap\(\)/.test(body) &&
        /GONE_ACTIVITIES_LOGGED\s*\.lock\(\)\s*\.unwrap\(\)\s*\.insert\(activity_id\)/.test(body) &&
        /\[WRY_MAIN_PIPE\] no WebView for activity/.test(body)
      );
    },
    upstream: `pub fn get_webview(activity_id: ActivityId) -> Option<GlobalRef> {
  ACTIVITY_PROXY
    .lock()
    .unwrap()
    .get(&activity_id)
    .unwrap()
    .webview
    .as_ref()
    .cloned()
}`,
  },
  {
    file: 'main_pipe.rs',
    what: 'recv is bounded by the length read on entry, logs a failed message, and clears a pending exception after EVERY message',
    holds: (s) => {
      const body = fnBody(s, 'recv');
      if (body === null) return false;
      const clearAt = body.indexOf('self.clear_pending_exception(');
      const errAt = body.indexOf('if let Err(');
      // The clear must sit AFTER the error branch closes, not inside it.
      const errBranchEnd = errAt === -1 ? -1 : body.indexOf('\n      }\n', errAt);
      return (
        /CHANNEL\.1\.len\(\)/.test(body) &&
        /for _ in 0\.\.pending/.test(body) &&
        !/while let Ok/.test(body) &&
        !/handle_message\([^)]*\)\s*\?/.test(body) &&
        /log::error!/.test(body) &&
        clearAt !== -1 &&
        errBranchEnd !== -1 &&
        clearAt > errBranchEnd
      );
    },
    upstream: `  pub fn recv(&mut self) -> JniResult<()> {
    let package = super::PACKAGE.get().unwrap();
    while let Ok((activity_id, message)) = CHANNEL.1.try_recv() {
      self.handle_message(package, activity_id, message)?;
    }
    Ok(())
  }`,
  },
  {
    file: 'main_pipe.rs',
    what: 'no reply is unwrapped: every answer goes through the logging `reply`',
    holds: (s) => /fn reply</.test(s) && !/tx\s*\.send\(/.test(without(s, 'reply')),
    upstream: `      WebViewMessage::GetUrl(tx) => {
        if let Some(webview) = get_webview(activity_id) {
          tx.send(url).unwrap()
        }
      }`,
  },
  {
    file: 'binding.rs',
    what: 'the looper callback retries an interrupted read, never stops on recv, and logs when it unregisters',
    holds: (s) => {
      const body = fnBody(s, 'onFirstActivityCreateWry');
      return (
        body !== null &&
        /ErrorKind::Interrupted/.test(body) &&
        /continue;/.test(body) &&
        !/recv\(\)\s*\.is_ok\(\)/.test(body) &&
        /return true;/.test(body) &&
        (body.match(/log::error!/g) ?? []).length >= 2
      );
    },
    upstream: `pub unsafe fn onFirstActivityCreateWry(env: JNIEnv, _: JClass) {
  unsafe {
    looper
      .add_fd_with_callback(MAIN_PIPE[0].as_fd(), FdEvent::INPUT, move |fd, _event| {
        let mut buf = [0u8];
        if libc::read(fd.as_raw_fd(), buf.as_mut_ptr() as *mut _, buf.len())
          == buf.len() as libc::ssize_t
        {
          // unregister itself on errors
          main_pipe.recv().is_ok()
        } else {
          // unregister itself
          false
        }
      })
      .unwrap();
  }
}`,
  },
];

const sources = {};
for (const file of new Set(PREDICATES.map((p) => p.file))) {
  try {
    sources[file] = readFileSync(join(ANDROID, file), 'utf8');
  } catch (error) {
    fail(
      `cannot read patches/wry/src/android/${file} (${error.message}) - nothing in it was checked`
    );
  }
}

for (const p of PREDICATES) {
  const source = sources[p.file];
  if (source !== undefined) {
    if (p.holds(source)) ok(p.what);
    else
      fail(
        `${p.what}: NOT in patches/wry/src/android/${p.file}. A rebase dropped a CANARI PATCH hunk - ` +
          `re-apply it (docs/wiki/frontend/mobile.md#wry-main-pipe-patch).`
      );
  }
  if (p.holds(p.upstream))
    fail(`the check "${p.what}" accepts the UPSTREAM code - it proves nothing`);
}

// THE PATCH SHIPS ONLY WHILE three facts hold together: the manifest routes wry to the fork, a
// `[dependencies]` pin names the fork's exact version (without it a newer registry release
// out-resolves the path patch), and the lockfile resolved wry from the PATH (no `source =` line).
const manifest = readFileSync(join(TAURI, 'Cargo.toml'), 'utf8');
const forkVersion = readFileSync(join(TAURI, 'patches', 'wry', 'Cargo.toml'), 'utf8').match(
  /^\[package\][\s\S]*?^version\s*=\s*"([^"]+)"/m
)?.[1];

if (/^wry\s*=\s*\{\s*path\s*=\s*"patches\/wry"\s*\}/m.test(manifest))
  ok('[patch.crates-io] routes wry to the fork');
else
  fail(
    'frontend/src-tauri/Cargo.toml no longer patches wry from patches/wry - the fixes do not ship'
  );

const dependencies = manifest.match(/^\[dependencies\]\n([\s\S]*?)(?=^\[)/m)?.[1] ?? '';
const pin = dependencies.match(/^wry\s*=\s*"=([^"]+)"/m)?.[1];
if (forkVersion && pin === forkVersion)
  ok(`[dependencies] pins wry to "=${pin}", the fork's version`);
else
  fail(
    `[dependencies] pins wry to '${pin ?? '<no exact pin>'}' but patches/wry is ${forkVersion ?? '<unreadable>'} - ` +
      'a patch that does not match the requirement is not applied'
  );

const lockEntry = readFileSync(join(TAURI, 'Cargo.lock'), 'utf8')
  .split('\n[[package]]\n')
  .find((entry) => /^name = "wry"$/m.test(entry));
if (lockEntry === undefined) fail('Cargo.lock has no wry entry');
else if (/^source = /m.test(lockEntry))
  fail('Cargo.lock resolves wry from a registry (`source =`), not from patches/wry');
else if (!new RegExp(`^version = "${forkVersion}"$`, 'm').test(lockEntry))
  fail(`Cargo.lock's wry entry is not version ${forkVersion}`);
else ok(`Cargo.lock resolves wry ${forkVersion} from the path, with no registry source`);

console.log(failures === 0 ? '\nall wry main-pipe checks hold' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
