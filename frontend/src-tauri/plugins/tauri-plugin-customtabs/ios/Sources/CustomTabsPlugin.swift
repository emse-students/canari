import AuthenticationServices
import SwiftRs
import Tauri
import UIKit
import WebKit

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
      NSLog("[CustomTabsPlugin] openCustomTab: the URL does not parse - refused")
      invoke.reject("Invalid URL")
      return
    }

    DispatchQueue.main.async {
      NSLog("[CustomTabsPlugin] openCustomTab: presenting a session")
      // A sheet already up belongs to an earlier invoke (a sign-out's end-session the user never
      // closed, then a sign-in). Its invoke is answered `cancelled` NOW and its session cancelled,
      // so no caller is left waiting on a sheet that is gone; its own completion, if UIKit still
      // runs it, finds it is no longer pending and settles nothing.
      if let earlier = self.pending {
        NSLog("[CustomTabsPlugin] openCustomTab: an earlier session is superseded")
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
            NSLog("[CustomTabsPlugin] session ended after it was superseded - nothing to settle")
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
        NSLog("[CustomTabsPlugin] openCustomTab: the session refused to start")
        self.pending = nil
        invoke.reject("ASWebAuthenticationSession refused to start")
        return
      }
    }
  }

  /// Answers the invoke for a session that ended: the outcome the page decides its button from.
  private func settle(_ invoke: Invoke, callbackURL: URL?, error: Error?) {
    if let callbackURL, error == nil {
      NSLog("[CustomTabsPlugin] session completed - re-dispatching the callback to the app scheme")
      UIApplication.shared.open(callbackURL, options: [:], completionHandler: nil)
      invoke.resolve(["outcome": "completed"])
      return
    }
    if let authError = error as? ASWebAuthenticationSessionError,
      authError.code == .canceledLogin
    {
      NSLog("[CustomTabsPlugin] session cancelled by the user")
      invoke.resolve(["outcome": "cancelled"])
      return
    }
    // Neither a callback nor the user's cancellation: a failure, said as one (the error's domain
    // and code only - its description may quote the URL).
    let nsError = error.map { $0 as NSError }
    NSLog(
      "[CustomTabsPlugin] session FAILED: domain=%@ code=%ld",
      nsError?.domain ?? "none (no callback and no error)", nsError?.code ?? 0)
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
    return UIApplication.shared.connectedScenes
      .compactMap { ($0 as? UIWindowScene)?.windows.first }
      .first ?? ASPresentationAnchor()
  }
}

@_cdecl("init_plugin_customtabs")
func initPlugin() -> Plugin {
  return CustomTabsPlugin()
}
