import AuthenticationServices
import SwiftRs
import Tauri
import UIKit
import WebKit
import os

/// The plugin's native log. A Swift `NSLog` reaches the unified log WHOLE as `<private>` on a store
/// build, literal text included (the tab-bar plugin's line, `1.6.4-alpha.4`; the notification
/// extension's, `1.6.5-alpha.1`); a `Logger`'s literal text is public, and each interpolation names
/// its privacy (`nativeLogContent.test.ts` refuses a Swift `NSLog` anywhere the app compiles).
enum CustomTabsLog {
  static let log = Logger(subsystem: "fr.emse.canari", category: "customtabs")
}

/// iOS counterpart to the Android Chrome Custom Tab (WP-OIDC-TAB-1): presents the OIDC login
/// page in an ASWebAuthenticationSession instead of handing it off to a full Safari app-switch
/// via tauri-plugin-opener's openUrl. The system chrome this presents is dismissed automatically
/// once the flow completes or is cancelled - the same practical outcome as the Custom Tab being
/// closed by the OS when the app resumes to the foreground on Android.
///
/// ASWebAuthenticationSession intercepts its `callbackURLScheme` redirect itself and never hands
/// it to the app's normal URL-opening delegate path - so unlike Android's intent-filter deep
/// link, it would NOT reach tauri-plugin-deep-link's onOpenUrl listener on its own. To keep
/// hooks.client.ts, /auth/callback and the fr.emse.canari:// scheme registration fully shared
/// between both platforms, the callback URL the session hands back is re-opened via
/// `UIApplication.open(_:)` - since fr.emse.canari:// is this app's own registered scheme, that
/// routes straight back into the same app-delegate path the Android deep link already uses.
///
/// THE INVOKE SETTLES WHEN THE SHEET GOES AWAY, NOT WHEN IT APPEARS (2026-11-04). It used to
/// resolve on presentation and drop a cancellation silently; the sheet is in-app, so closing it
/// raises no visibility, focus or foreground edge, and the login page held its button on
/// "Redirection..." until the app was killed. The answer is now the session's END, typed:
/// `completed` (the callback was re-dispatched), `cancelled` (the user closed it), or a rejection
/// (it failed, or would not start). `CustomTabOutcome` in `src/models.rs` is the other half.
///
/// VERIFIED ON HARDWARE 2026-08-27 (iPhone, iOS 18.7, against production): the session presented,
/// the redirect was intercepted, the self-reinvocation routed back into the app and /auth/callback
/// ran. `presentationAnchor` is device-agnostic by construction, so an iPhone run stands for an
/// iPad too.
class CustomTabsPlugin: Plugin, ASWebAuthenticationPresentationContextProviding {
  /// The session on screen and the invoke waiting for its end. The session is kept alive here -
  /// ASWebAuthenticationSession is deallocated (and its sheet dismissed) the instant nothing
  /// retains it - and the pair is what makes each invoke settle EXACTLY ONCE: only the completion
  /// of the session still pending may settle it. Touched on the main queue only.
  private var pending: (session: ASWebAuthenticationSession, invoke: Invoke)?

  class OpenCustomTabArgs: Decodable {
    let url: String
  }

  /// Opens `url` in an ASWebAuthenticationSession. `callbackURLScheme` is this app's own
  /// registered scheme (fr.emse.canari) - the session watches for a redirect to it and treats
  /// that as completion.
  ///
  /// Resolves `{ outcome: "completed" }` once the callback has been handed to the shared deep-link
  /// pipeline (hooks.client.ts), `{ outcome: "cancelled" }` when the user closed the sheet, and
  /// rejects when the session failed or could not start.
  @objc public func openCustomTab(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(OpenCustomTabArgs.self)

    // The URL is never logged: it carries the OIDC state and the PKCE challenge.
    guard let url = URL(string: args.url) else {
      CustomTabsLog.log.error("[CustomTabsPlugin] openCustomTab: the URL does not parse - refused")
      invoke.reject("Invalid URL")
      return
    }

    DispatchQueue.main.async {
      CustomTabsLog.log.notice("[CustomTabsPlugin] openCustomTab: presenting a session")
      // A sheet already up belongs to an earlier invoke (a sign-out's end-session the user never
      // closed, then a sign-in). Its invoke is answered `cancelled` NOW and its session cancelled,
      // so no caller is left waiting on a sheet that is gone; its own completion, if UIKit still
      // runs it, finds it is no longer pending and settles nothing.
      if let earlier = self.pending {
        CustomTabsLog.log.notice("[CustomTabsPlugin] openCustomTab: an earlier session is superseded")
        self.pending = nil
        earlier.invoke.resolve(["outcome": "cancelled"])
        earlier.session.cancel()
      }

      // Weak: the session owns this handler, so a strong reference back would keep it alive for ever.
      weak var created: ASWebAuthenticationSession?
      let session = ASWebAuthenticationSession(
        url: url,
        callbackURLScheme: "fr.emse.canari"
      ) { [weak self] callbackURL, error in
        // The completion handler's queue is not documented; the pending pair is main-queue state.
        DispatchQueue.main.async {
          guard let self, let created, let current = self.pending, current.session === created
          else {
            CustomTabsLog.log.notice("[CustomTabsPlugin] session ended after it was superseded - nothing to settle")
            return
          }
          self.pending = nil
          self.settle(current.invoke, callbackURL: callbackURL, error: error)
        }
      }
      created = session

      session.presentationContextProvider = self
      // Share Safari's cookie jar (Authentik session, "remember me") rather than forcing a
      // fresh login every time - matches what a normal browser tab would do.
      session.prefersEphemeralWebBrowserSession = false
      self.pending = (session, invoke)
      guard session.start() else {
        // `start()` refuses when there is no window to present from or a session is already
        // presented: no sheet ever appeared, so the caller must hear it at once.
        CustomTabsLog.log.error("[CustomTabsPlugin] openCustomTab: the session refused to start")
        self.pending = nil
        invoke.reject("ASWebAuthenticationSession refused to start")
        return
      }
    }
  }

  /// Answers the invoke for a session that ended: the outcome the page decides its button from.
  private func settle(_ invoke: Invoke, callbackURL: URL?, error: Error?) {
    if let callbackURL, error == nil {
      CustomTabsLog.log.notice("[CustomTabsPlugin] session completed - re-dispatching the callback to the app scheme")
      // `completed` is answered only once the re-dispatch is KNOWN to have reached the app: the
      // page keeps its button busy on `completed`, waiting for `/auth/callback`, so a re-dispatch
      // that failed and was answered `completed` would be the stuck "Redirection..." again.
      UIApplication.shared.open(callbackURL, options: [:]) { opened in
        if opened {
          CustomTabsLog.log.notice("[CustomTabsPlugin] callback re-dispatched to the app scheme")
          invoke.resolve(["outcome": "completed"])
        } else {
          CustomTabsLog.log.error(
            "[CustomTabsPlugin] ERROR the callback could not be re-dispatched to the app scheme - the sign-in is lost"
          )
          invoke.reject("the callback could not be re-dispatched to the app scheme")
        }
      }
      return
    }
    if let authError = error as? ASWebAuthenticationSessionError,
      authError.code == .canceledLogin
    {
      CustomTabsLog.log.notice("[CustomTabsPlugin] session cancelled by the user")
      invoke.resolve(["outcome": "cancelled"])
      return
    }
    // Neither a callback nor the user's cancellation: a failure, said as one (the error's domain
    // and code only - its description may quote the URL).
    let nsError = error.map { $0 as NSError }
    let domain = nsError?.domain ?? "none (no callback and no error)"
    let code = nsError?.code ?? 0
    CustomTabsLog.log.error(
      "[CustomTabsPlugin] session FAILED: domain=\(domain, privacy: .public) code=\(code, privacy: .public)")
    invoke.reject(
      "ASWebAuthenticationSession failed: \(nsError?.domain ?? "no callback") \(nsError?.code ?? 0)"
    )
  }

  func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
    for scene in UIApplication.shared.connectedScenes {
      if let windowScene = scene as? UIWindowScene,
        let window = windowScene.windows.first(where: { $0.isKeyWindow })
      {
        return window
      }
    }
    // A FALLBACK IS A SIGNAL: no key window means the app is presenting from a state the primary
    // path does not expect (backgrounded, mid scene change). Said at a level that accuses.
    CustomTabsLog.log.error("[CustomTabsPlugin] ERROR FALLBACK presentationAnchor: no key window - using a scene's first window")
    if let window = UIApplication.shared.connectedScenes
      .compactMap({ ($0 as? UIWindowScene)?.windows.first }).first
    {
      return window
    }
    CustomTabsLog.log.error("[CustomTabsPlugin] ERROR FALLBACK presentationAnchor: no window at all - an empty anchor")
    return ASPresentationAnchor()
  }
}

@_cdecl("init_plugin_customtabs")
func initPlugin() -> Plugin {
  return CustomTabsPlugin()
}
