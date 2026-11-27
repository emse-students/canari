import Intents
import UIKit
import UserNotifications
import os

/// "Canari" in the iPhone share sheet: copies the share into the App Group (`ShareCapture`), then
/// tells the member how to reach it.
///
/// WHY A NOTIFICATION AND NOT "OPEN CANARI". A share extension has no public API to open its
/// containing app, and the responder-chain walk to `openURL:` that some apps use is a private path
/// App Review can refuse - so it is not used. The app imports the share on its next activation
/// (`canari_ios.mm`), and a local notification is the one public, tappable way to bring it there:
/// its tap opens Canari, which finds the share waiting. When notifications are not allowed, the
/// confirmation says to open Canari instead. See docs/wiki/frontend/sharing.md.
///
/// The strings are this bundle's own `Localizable.strings` (fr, en): an extension cannot read the
/// app's, and Paraglide is the web layer's.
final class ShareViewController: UIViewController {
    private let log = Logger(subsystem: "fr.emse.canari", category: "share")
    private let card = UIView()
    private let message = UILabel()
    private let spinner = UIActivityIndicatorView(style: .medium)
    private let doneButton = UIButton(type: .system)
    private var started = false

    override func viewDidLoad() {
        super.viewDidLoad()
        // First line of the extension's life: its absence means the system never started it (a suggestion
        // row that launches nothing); its presence without the `opened` line below means it never appeared.
        let launchedWithIntent = extensionContext?.intent != nil
        log.notice("[CanariShare] share extension launched, intent=\(launchedWithIntent)")  // log-safe: a Bool, whether the system handed the extension an intent
        // A copy in progress holds the App Group lock; a swipe-down would end the extension mid-copy.
        isModalInPresentation = true
        view.backgroundColor = UIColor.black.withAlphaComponent(0.3)
        card.backgroundColor = .systemBackground
        card.layer.cornerRadius = 12
        card.translatesAutoresizingMaskIntoConstraints = false
        message.numberOfLines = 0
        message.textAlignment = .center
        message.font = UIFont.preferredFont(forTextStyle: .body)
        message.adjustsFontForContentSizeCategory = true
        message.text = NSLocalizedString("share.copying", comment: "While the share is copied")
        doneButton.setTitle(NSLocalizedString("share.ok", comment: "Closes the confirmation"), for: .normal)
        doneButton.titleLabel?.font = UIFont.preferredFont(forTextStyle: .headline)
        doneButton.isHidden = true
        doneButton.addTarget(self, action: #selector(closeTapped), for: .touchUpInside)
        spinner.startAnimating()
        let stack = UIStackView(arrangedSubviews: [spinner, message, doneButton])
        stack.axis = .vertical
        stack.spacing = 16
        stack.alignment = .fill
        stack.translatesAutoresizingMaskIntoConstraints = false
        card.addSubview(stack)
        view.addSubview(card)
        NSLayoutConstraint.activate([
            card.leadingAnchor.constraint(equalTo: view.layoutMarginsGuide.leadingAnchor, constant: 16),
            card.trailingAnchor.constraint(equalTo: view.layoutMarginsGuide.trailingAnchor, constant: -16),
            card.centerYAnchor.constraint(equalTo: view.centerYAnchor),
            stack.topAnchor.constraint(equalTo: card.topAnchor, constant: 24),
            stack.bottomAnchor.constraint(equalTo: card.bottomAnchor, constant: -24),
            stack.leadingAnchor.constraint(equalTo: card.leadingAnchor, constant: 24),
            stack.trailingAnchor.constraint(equalTo: card.trailingAnchor, constant: -24),
        ])
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        guard !started else { return }
        started = true
        let items = (extensionContext?.inputItems as? [NSExtensionItem]) ?? []
        let intent = extensionContext?.intent
        let isSendMessage = intent is INSendMessageIntent
        let target = suggestedTarget()
        // The line a reading of the share sheet's suggestion row looks for (no id, no name): which path
        // the sheet took - an intent handed over or not, of what shape, and whether it became a target.
        log.notice("[CanariShare] share extension opened with \(items.count) item(s), intent=\(intent != nil), send_message_intent=\(isSendMessage), suggestion=\(target != nil)")
        DispatchQueue.global(qos: .userInitiated).async {
            let outcome = ShareCapture().run(items: items, target: target)
            DispatchQueue.main.async {
                self.show(outcome)
            }
        }
    }

    /// The conversation the member picked among the share sheet's suggestions (sharing lot S5): the
    /// `INSendMessageIntent` the app donated (`ShareSuggestions.swift`) comes back as the
    /// extension context's intent, and its `conversationIdentifier` is carried into the manifest as
    /// `target` - the hint Android's `EXTRA_SHORTCUT_ID` gives. nil when the extension was picked
    /// from the app row, or when the identifier is not of the suggestion shape (said, not used).
    private func suggestedTarget() -> String? {
        guard let intent = extensionContext?.intent as? INSendMessageIntent else { return nil }
        guard let target = ShareRules.suggestedTarget(intent.conversationIdentifier) else {
            log.warning("[CanariShare] a suggestion whose conversation identifier is not of the suggestion shape was ignored (identifier present: \(intent.conversationIdentifier != nil), \(intent.conversationIdentifier?.count ?? 0) characters)")
            return nil
        }
        // A pick made while nobody is signed in has no account to land in. A leftover sender of a
        // PREVIOUS account (the notification extension erases its donations on its next run) is
        // not decided here: the page preselects a hint only when the signed-in account holds that
        // conversation (`suggestionIfHeld`), and refusing here on the donations' owner would also
        // drop the new account's own suggestions until that run.
        guard let store = FileManager.default.containerURL(
            forSecurityApplicationGroupIdentifier: ShareCapture.appGroupId)?
            .appendingPathComponent(ShareCapture.storeDirName, isDirectory: true)
        else {
            log.error("[CanariShare] the App Group container is unavailable - the suggestion is not used")
            return nil
        }
        guard ShareRules.suggestionUsable(signedInUserId: signedInUserId(store)) else {
            log.notice("[CanariShare] a suggestion was not used: no account is signed in")
            return nil
        }
        return target
    }

    /// The account `push_context.json` says is signed in, nil when none is (absent, unreadable, or
    /// stripped of `baseUrl` by a sign-out) - `NotificationService.signedInUserId`, the same rule.
    private func signedInUserId(_ store: URL) -> String? {
        guard let data = try? Data(contentsOf: store.appendingPathComponent("push_context.json")),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return nil }
        let userId = json["userId"] as? String ?? ""
        let deviceId = json["deviceId"] as? String ?? ""
        let baseUrl = json["baseUrl"] as? String ?? ""
        guard !userId.isEmpty, !deviceId.isEmpty, !baseUrl.isEmpty else { return nil }
        return userId
    }

    private func show(_ outcome: ShareCaptureOutcome) {
        switch outcome {
        case .handedOver(let files, let refused):
            log.notice("[CanariShare] share handed over: \(files) file(s), \(refused) refused")
            announce()
        case .keptNothing(let refused):
            // The app tells the member what was refused once they open it, as on Android.
            log.notice("[CanariShare] share kept nothing, \(refused) refusal(s) handed over")
            announce()
        case .empty:
            finish(NSLocalizedString("share.empty", comment: "Nothing in the share could be taken"))
        case .failed:
            finish(NSLocalizedString("share.failed", comment: "The share could not be prepared"))
        }
    }

    /// Posts the notification whose tap opens Canari, when the member allows notifications; says to
    /// open Canari otherwise. One identifier, so a second share replaces the first one's banner.
    private func announce() {
        let center = UNUserNotificationCenter.current()
        center.getNotificationSettings { settings in
            let status = settings.authorizationStatus
            guard status == .authorized || status == .provisional || status == .ephemeral else {
                self.log.notice("[CanariShare] notifications not allowed - the member is told to open Canari")
                DispatchQueue.main.async {
                    self.finish(NSLocalizedString("share.done.open_app", comment: "Open Canari to choose"))
                }
                return
            }
            let content = UNMutableNotificationContent()
            content.title = NSLocalizedString("share.notification.title", comment: "The banner's title")
            content.body = NSLocalizedString("share.notification.body", comment: "The banner's body")
            content.threadIdentifier = "canari_share"
            // What the app's notification delegate recognises a share's banner by (`canari_push.mm`):
            // its tap carries no deep link, and that is expected, not a payload that lost its field.
            content.userInfo = ["canariLocal": "incoming_share"]
            let request = UNNotificationRequest(identifier: "canari.share.ready", content: content, trigger: nil)
            center.add(request) { error in
                if let error = error {
                    self.log.error("[CanariShare] the share notification was not posted: \(error.localizedDescription)")
                } else {
                    self.log.notice("[CanariShare] share notification posted")
                }
                DispatchQueue.main.async {
                    self.finish(error == nil
                        ? NSLocalizedString("share.done.notified", comment: "Tap the notification")
                        : NSLocalizedString("share.done.open_app", comment: "Open Canari to choose"))
                }
            }
        }
    }

    private func finish(_ text: String) {
        spinner.stopAnimating()
        spinner.isHidden = true
        message.text = text
        doneButton.isHidden = false
        isModalInPresentation = false
    }

    @objc private func closeTapped() {
        log.notice("[CanariShare] share extension closed")
        extensionContext?.completeRequest(returningItems: [], completionHandler: nil)
    }
}
