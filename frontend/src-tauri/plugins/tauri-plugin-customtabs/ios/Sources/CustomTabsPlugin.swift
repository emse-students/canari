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
/// UNVERIFIED ON HARDWARE: this repo has never run an iOS build on a device or simulator (see
/// CLAUDE.md, device-verification ladder). This self-reinvocation path is the one piece of this
/// plugin with real behavioral uncertainty - it should be the first thing checked once it can be.
class CustomTabsPlugin: Plugin, ASWebAuthenticationPresentationContextProviding {
  /// Keeps the session alive for the duration of the flow - ASWebAuthenticationSession is
  /// deallocated (and its sheet dismissed) the instant nothing retains it.
  private var session: ASWebAuthenticationSession?

  class OpenCustomTabArgs: Decodable {
    let url: String
  }

  /// Opens `url` in an ASWebAuthenticationSession. `callbackURLScheme` is this app's own
  /// registered scheme (fr.emse.canari) - the session watches for a redirect to it and treats
  /// that as completion.
  ///
  /// Resolves as soon as the session is presented, not when the flow finishes - matching the
  /// fire-and-forget contract of Android's openCustomTab and of the openUrl call this replaces
  /// on iOS. The actual OIDC result continues to flow entirely through the shared deep-link
  /// pipeline (hooks.client.ts), unchanged.
  @objc public func openCustomTab(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(OpenCustomTabArgs.self)

    guard let url = URL(string: args.url) else {
      invoke.reject("Invalid URL: \(args.url)")
      return
    }

    DispatchQueue.main.async {
      let session = ASWebAuthenticationSession(
        url: url,
        callbackURLScheme: "fr.emse.canari"
      ) { [weak self] callbackURL, error in
        self?.session = nil
        guard let callbackURL = callbackURL, error == nil else {
          // Cancelled by the user, or failed - nothing to forward. Neither Android's
          // openCustomTab nor the previous iOS openUrl reports a failure past this point
          // either; the login page itself is the only thing that communicates that today.
          return
        }
        UIApplication.shared.open(callbackURL, options: [:], completionHandler: nil)
      }

      session.presentationContextProvider = self
      // Share Safari's cookie jar (Authentik session, "remember me") rather than forcing a
      // fresh login every time - matches what a normal browser tab would do.
      session.prefersEphemeralWebBrowserSession = false
      self.session = session
      session.start()
      invoke.resolve()
    }
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
