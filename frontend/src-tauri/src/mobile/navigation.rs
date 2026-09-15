//! Which URLs this application's own WebView is allowed to start loading.
//!
//! # Why a navigation is a decision the app has to make, and cannot delegate
//!
//! Wry's Android bridge keeps the last URL the WebView STARTED loading
//! (`RustWebViewClient.onPageStarted` sets `currentUrl`) and hands it to every subsequent IPC
//! message as that request's URI:
//!
//! ```text
//! (ipc.handler)(Request::builder().uri(url).body(body).unwrap())   // wry-0.55.1 android/binding.rs:397
//! ```
//!
//! `Request::builder().uri(..)` goes through `http::Uri`, which accepts origin-form,
//! authority-form and `scheme://authority/path` - and nothing else. A `scheme:/path` carrying no
//! authority is none of the three, so the builder errors and that `unwrap()` panics. It panics
//! inside `Java_fr_emse_canari_Rust_ipc`, an `extern "C"` frame, and a panic that cannot unwind is
//! an ABORT: SIGABRT, the activity force-finished, the sandboxed renderer dead with it. There is
//! no JS error, no `svelte:boundary`, nothing a `catch` on either side of the bridge can reach.
//! Measured on A1 (build `7fea1bb42`, LineageOS 23.2 / Android 11, arm64) on 2026-09-14: the app
//! vanished every time, and the message being sent was irrelevant - once the WebView has started
//! loading such a URL, the NEXT IPC kills the app, whatever it carries.
//!
//! The defect is upstream and it is fixed upstream (`wry` 0.56.1, tauri-apps/wry#1772), but every
//! stable `tauri-runtime-wry` pins `wry ^0.55`; only `tauri-runtime-wry 3.0.0-alpha.0` asks for
//! `^0.56`. Waiting is not a disposition. The half this application owns is the input: a boundary
//! that cannot unwind owes a `Result`, and when the boundary belongs to someone else the only
//! thing left to own is what reaches it. So the navigation is refused BEFORE the WebView starts
//! it - `onPageStarted` never fires, and `currentUrl` never becomes the value that kills the
//! process.
//!
//! # The predicate is the invariant, not a list of schemes
//!
//! A scheme allowlist would be a second, hand-kept copy of a rule `http::Uri` already states, and
//! the two would agree only for as long as somebody kept them agreeing. Exactly one thing has to
//! hold - `currentUrl` must remain something `http::Uri` can parse - so that is what is asked, of
//! the URL itself. Everything this application legitimately loads satisfies it:
//! `http://tauri.localhost/...` (Android's asset loader), `tauri://localhost/...` (iOS), any
//! `https://`, and `about:blank`, which is wry's own initial value.
//!
//! Beyond the measured case it also refuses `blob:`, `data:` and `file:` - and each of those is a
//! URL that would abort the app for the same reason, so refusing them is the point rather than a
//! side effect. Nothing here navigates to one: on Tauri a download goes through the native save
//! dialog (`fileDownload.ts`), and an object URL behind an `<img>` or a `<video>` is a subresource,
//! which reaches `shouldInterceptRequest` and never `shouldOverrideUrlLoading`.
//!
//! # What this does NOT close
//!
//! `tauri-runtime-wry` parses the string into a `url::Url` before calling this handler and allows
//! the navigation outright if that parse fails (`unwrap_or(true)`, its lib.rs:4898). So a string
//! `url::Url` refuses and `http::Uri` also refuses would still reach the WebView. It is a narrow
//! residue - Android hands over `request.url.toString()`, always absolute, and `url::Url` accepts
//! far more than `http::Uri` does (every case in this module's tests parses as a `url::Url`, the
//! killer included) - but it is a residue, not a proof, and it closes when the `wry` fix becomes
//! reachable rather than here.

/// True when the WebView may start loading `url`.
///
/// See the module docs: the one question is whether this string can still be turned into an
/// `http::Uri` when wry hands it back on the next IPC. If it cannot, loading it arms an abort that
/// no error boundary on either side of the bridge can contain.
pub fn webview_may_load(url: &str) -> bool {
    let allowed = url.parse::<tauri::http::Uri>().is_ok();
    if allowed {
        log::debug!("[nav] allowing navigation to {url}");
    } else {
        // ACCUSING on purpose. Reaching this is not a user doing something exotic - it is a link
        // this application rendered, or a redirect it followed, that would have killed the
        // process. Whatever produced it is a defect, and this line is the only thing that will
        // ever name it: the refusal itself is silent to the user, and has to be.
        log::error!(
            "[nav] REFUSED navigation to {url} - http::Uri cannot parse it, and loading it would abort the process"
        );
    }
    allowed
}

#[cfg(test)]
mod tests {
    use super::webview_may_load;

    /// The exact string measured on A1 on 2026-09-14, the one that killed the app three times.
    ///
    /// No product code produced it: Git Bash rewrites a leading-slash argument into a Windows
    /// path, so `bun sweep.mjs --route /posts` reached the sweep as `C:/Program Files/Git/posts`
    /// and the DOM resolved that to this. An MSYS argument produced a URL nothing in this
    /// repository would - which is precisely why the guarantee has to be a property of this
    /// function rather than of the renderers.
    const THE_KILLER: &str = "c:/Program%20Files/Git/posts";

    #[test]
    fn refuses_the_url_that_aborted_the_app() {
        assert!(!webview_may_load(THE_KILLER));
    }

    #[test]
    fn refuses_every_url_that_carries_no_parseable_authority() {
        // Not a denylist - each of these is refused by the same single question, and each would
        // abort the process for the same single reason.
        for url in [
            "blob:http://tauri.localhost/6d0f-4c1e",
            "data:text/plain,hello",
            "file:///android_asset/index.html",
            "",
        ] {
            assert!(!webview_may_load(url), "expected {url} to be refused");
        }
    }

    #[test]
    fn allows_everything_this_app_actually_loads() {
        for url in [
            // Android's asset loader domain, and iOS's custom scheme.
            "http://tauri.localhost/",
            "http://tauri.localhost/posts",
            "tauri://localhost/settings",
            // A path with a space in it - the DOM percent-encodes it, and it measured ALIVE.
            "http://tauri.localhost/a%20b",
            // The desktop dev server, and the public site a link may point back at.
            "http://localhost:1430/",
            "https://canari-emse.fr/posts/1",
            // The OIDC authorize URL, which the desktop WebView really does navigate to.
            "https://auth.canari-emse.fr/application/o/authorize/?client_id=x&state=y",
            // The deep link Authentik sends the mobile clients back through.
            "fr.emse.canari://callback?code=1&state=2",
            // wry's own initial `currentUrl`, before anything has been loaded at all.
            "about:blank",
        ] {
            assert!(webview_may_load(url), "expected {url} to be allowed");
        }
    }
}
