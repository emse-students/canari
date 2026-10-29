import Security
import UIKit
import UserNotifications

/// What an `NSLog` line says of an error: its domain and code, never its text - a
/// `localizedDescription` often quotes the file it failed on, and NSLog redacts nothing. The
/// Objective-C twin is `CanariErrorReason` (`canari_push.h`); `nativeLogContent.test.ts` holds both.
private func errorReason(_ error: Error) -> String {
  let failure = error as NSError
  return "\(failure.domain) \(failure.code)"
}

/// Canari Notification Service Extension.
///
/// Runs in its own process for every incoming `mutable-content: 1` push and
/// rewrites the visible alert with the decrypted message text before it is shown
/// (WP-iOS-6). The server only ever sends ciphertext + metadata, so without this
/// extension the user would see the generic "Nouveau message" fallback baked into
/// the APNs payload (push-payload.ts `APNS_FALLBACK_BODY`).
///
/// It is a lean, self-contained peer of the in-app background handler
/// (`canari_push.mm` `CanariHandleMlsMessage` / `CanariHandleChannelMessage`): it
/// reuses the exact same Rust decrypt FFI (`canari_native_*`, linked from
/// libapp.a) but reads the MLS state, push context and channel keys from the
/// shared App Group container (`group.fr.emse.canari`) that the app mirrors into
/// on every foreground/background transition. All decryption is read-only - the
/// extension never writes mls.bin. This is why the app's `g_mlsStateLock`
/// (canari_push.mm) never needs a cross-process peer here: see the doc comment at
/// its declaration for the full argument.
///
/// Richness (WP-iOS-7): the rewritten notification carries a per-conversation
/// `threadIdentifier` (stacked per chat instead of one flat "canari_messages"
/// thread), the sender name as a subtitle inside group chats, and the sender's
/// avatar as an attachment when it can be fetched in time.
class NotificationService: UNNotificationServiceExtension {
  /// App Group shared with the main app; the app mirrors the decrypt inputs here.
  private static let appGroupId = "group.fr.emse.canari"

  /// Files mirrored by the app into the App Group container (see canari_push.mm
  /// `CanariMirrorPushStateToAppGroup`).
  private static let mlsBinFile = "mls.bin"
  private static let pushContextFile = "push_context.json"
  private static let pushSecretFile = "push_secret.txt"
  /// Present while the app is in the foreground (`CanariSetAppGroupForegroundFlag`, canari_ios.mm).
  static let appInForegroundFile = "app_in_foreground"

  /// The alias of the install's native cache key (Rust `native_cache`, the only copy of the
  /// design), which seals `graine_seeds.json` and the push cache. Spelled in `native_cache.rs`,
  /// `NativeCacheKey.kt` and `canari_ios.mm` too; `nativeCacheSeal.test.ts` holds the four together.
  private static let nativeCacheKeyAlias = "canari_native_cache_key"

  /// Cap the decrypted preview length, matching the 200-char clamp the in-app path uses.
  private static let maxPreviewLength = 200

  /// FCM message cache file: the app pre-injects these entries at boot via
  /// `take_fcm_cache`, so a message decrypted while the app was killed shows up
  /// without waiting for the full MLS sync. Android twin:
  /// `CanariFirebaseMessagingService.writeFcmCache`.
  ///
  /// Written into the **App Group container**, not the extension's own Application Support:
  /// an app extension has its own data container, so the `app_data_dir` path the Android
  /// service and `take_fcm_cache` share resolves, inside this process, to a
  /// directory the app can never read. The App Group is the only storage the two processes
  /// have in common - it is already where `mls.bin` is read from. `CanariDrainAppGroupFcmCache`
  /// moves the entries into the app's own file on the next activation.
  private static let fcmCacheFileName = "fcm_message_cache.ndjson"

  /// Maximum number of entries kept in `fcm_message_cache.ndjson`.
  private static let maxFcmCacheEntries = 50

  /// The initials disc drawn when no avatar can be fetched - see `initialsImageUrl`. Twins of
  /// `kCanariInitialsSize` / `kCanariInitialsLetterRatio` in `canari_push.mm`, duplicated because
  /// the appex is a separate bundle.
  private static let kInitialsSize: CGFloat = 192
  private static let kInitialsLetterRatio: CGFloat = 0.4

  /// The palette-A "mention" trill (docs/wiki/frontend/sounds.md), bundled in this target and the
  /// app. The "message" and "reaction" trills are named by the server in the APNs `sound`; a mention
  /// is the one the server cannot see. Twin of `kCanariSoundMention` in `canari_push.mm`;
  /// `iosNotificationSounds.test.ts` holds the names together.
  private static let mentionSoundFile = "canari_gazouillis_mention.wav"
  /// The palette-A "message" trill, which the server names on a salon push it does not call a
  /// mention. Set here only to take back the mention trill the server named on a BLIND salon banner,
  /// whose mention nothing proved - see `channelBannerAttribution`.
  private static let messageSoundFile = "canari_gazouillis_message.wav"

  /// Serializes NSE writes to `fcm_message_cache.ndjson`. The NSE runs in a separate
  /// process from the app, so it does not need to share the app's lock, but its own
  /// concurrent invocations must serialize writes to avoid torn NDJSON.
  private static let fcmCacheLock = NSLock()

  private var contentHandler: ((UNNotificationContent) -> Void)?
  private var bestAttemptContent: UNMutableNotificationContent?

  override func didReceive(
    _ request: UNNotificationRequest,
    withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void
  ) {
    self.contentHandler = contentHandler
    let mutable = request.content.mutableCopy() as? UNMutableNotificationContent
    self.bestAttemptContent = mutable

    guard let content = mutable else {
      contentHandler(request.content)
      return
    }

    let userInfo = request.content.userInfo
    let type = Self.string(userInfo["type"]) ?? "message"
    NSLog("[CanariNSE] didReceive type=\(type)")

    switch type {
    case "channel":
      handleChannelMessage(userInfo: userInfo, content: content)
    case "social" where Self.string(userInfo["reaction"]) == "true":
      // A reaction rides on `social` so that clients predating this change still render it
      // rather than dropping it into the MLS ladder - see notify-reaction in
      // chat-delivery-service. Its server-composed body is a French fallback for exactly those
      // clients; here it is replaced by one in the phone's own language.
      applyReactionContent(userInfo: userInfo, content: content)
      finish()
    case "call_ring":
      // The GENERIC ring alert of an iPhone with no VoIP token (calls.service `ringViaFcm`, no native
      // ring until CALLS_NATIVE_RING_COMPILED). It is NOT an MLS message: falling to the default
      // branch would overwrite the server's "Appel entrant" with the encrypted-message fallback and
      // add message buttons. The server's title and body are KEPT; only the filing is set here.
      applyGenericCallRing(userInfo: userInfo, content: content)
      finish()
    case "social", "form_reminder":
      // Not encrypted, and since 2026-08-19 not composed by the server either: the payload carries
      // a `contentKey` and the two untranslatable pieces, and the sentence is written here in the
      // language chosen in the app. A payload without one only a server predating that change can
      // send, and its own `title`/`body` are then left untouched.
      //
      // `channel_read` used to be listed here too, and could never arrive: the extension runs on
      // `mutable-content: 1` ALERT pushes only, and buildInternalApnsRequest sends every silent
      // frame as `content-available: 1` / `apns-push-type: background`. A background push goes to
      // the app (canari_push.mm `CanariHandleFcmData`, which clears the channel's notification);
      // it never reaches this process. Listing it here read as "handled" and was a dead branch.
      applyServerContent(userInfo: userInfo, content: content)
      attachSocialIcon(userInfo: userInfo, content: content)
      finish()
    default:
      handleMlsMessage(userInfo: userInfo, content: content)
    }
  }

  /// Files the generic incoming-call alert: stacked under its conversation, opening it on a tap, and
  /// time-sensitive so it breaks through Focus. The wording is the server's own (localized from the
  /// device's `push_token.locale`, no caller and no conversation name) and is left untouched. The
  /// deep link carries NO `acceptCall`: nothing native answers a call yet, the app only opens the
  /// conversation. `canariCallId` lets a later `call_ring_end` remove this banner.
  private func applyGenericCallRing(
    userInfo: [AnyHashable: Any],
    content: UNMutableNotificationContent
  ) {
    let groupId = Self.string(userInfo["groupId"]) ?? ""
    let callId = Self.string(userInfo["callId"]) ?? ""
    if #available(iOS 15.0, *) {
      content.interruptionLevel = .timeSensitive
    }
    if groupId.isEmpty {
      NSLog("[CanariNSE] call_ring with no groupId - banner kept without a deep link")
    } else {
      content.threadIdentifier = groupId
      content.userInfo["deepLink"] = "fr.emse.canari://chat/\(groupId)"
    }
    if !callId.isEmpty {
      content.userInfo["canariCallId"] = callId
    }
  }

  /// Writes a server-sent notification's sentence here, in the language chosen inside Canari.
  ///
  /// The services are the only layer that cannot know the reader's language - no header carries it
  /// and no column stores it - so they send WHAT the notification is and this process says it. An
  /// absent key means a server older than that change, and an unknown one means a key this build
  /// does not know; both leave the server's own wording, which at least says something true, and
  /// both are logged, since after the shim is removed either is a payload that lost a field.
  private func applyServerContent(
    userInfo: [AnyHashable: Any],
    content: UNMutableNotificationContent
  ) {
    guard let key = Self.nonEmpty(Self.string(userInfo["contentKey"])) else {
      NSLog("[CanariNSE] server push with no contentKey - keeping its own wording")
      return
    }
    let locale = loadPushContext()?.locale
    let actor = Self.string(userInfo["actorName"]) ?? ""
    let arg = Self.string(userInfo["contentArg"]) ?? ""

    /// Title from the actor, body from the fragment or a fixed sentence when it is empty.
    func actorTitled(_ stem: String) -> (String, String) {
      let body = arg.isEmpty ? Self.localized("notif.social.\(stem).body", locale: locale) : arg
      return (Self.localizedFormat("notif.social.\(stem).title", actor, locale: locale), body)
    }

    let composed: (String, String)?
    switch key {
    case "social_mention": composed = actorTitled("mention")
    case "social_reply": composed = actorTitled("reply")
    case "social_comment": composed = actorTitled("comment")
    // The two publication notices take the same shape as a comment: the actor names the
    // title - an association for the first, a person for the second - and the post's own
    // opening is the body, or a fixed sentence when the post carries only images.
    case "social_association_post": composed = actorTitled("association_post")
    case "social_followed_post": composed = actorTitled("followed_post")
    // Republication (D38): the republishing, then the proposing, association names the title.
    case "social_association_repost": composed = actorTitled("association_repost")
    case "social_repost_proposed": composed = actorTitled("repost_proposed")
    // D38b: an association asks the AUTHOR to republish their personal post.
    case "social_repost_personal_requested": composed = actorTitled("repost_personal_requested")
    // Co-organisation (D39): the organising association names the title, the event is the body.
    case "social_coorganise_proposed": composed = actorTitled("coorganise_proposed")
    // A live started (WP-L7): the broadcaster names the title, the body is the fixed sentence.
    case "social_live_started": composed = actorTitled("live_started")
    // A follow request and its acceptance (WP-F2): the person names the title, fixed body.
    case "social_follow_request": composed = actorTitled("follow_request")
    case "social_follow_accepted": composed = actorTitled("follow_accepted")
    // The bookings' notices (WP-N): who acted names the title, the place (or the organiser's
    // word) is the body, a fixed sentence on a link-only space (Q-R5).
    case "social_booking_cancelled": composed = actorTitled("booking_cancelled")
    case "social_booking_withdrawn": composed = actorTitled("booking_withdrawn")
    case "social_booking_added": composed = actorTitled("booking_added")
    // The reminder: nobody acted, a fixed title; the body is the place and the time.
    case "social_booking_reminder":
      composed = (
        Self.localized("notif.social.booking_reminder.title", locale: locale),
        arg.isEmpty ? Self.localized("notif.social.booking_reminder.body", locale: locale) : arg
      )
    // The strike ladder's three notices to a broadcaster (WP-L8b): fixed sentences, no actor and
    // no fragment.
    case "social_live_cut", "social_live_suspended", "social_live_withdrawn":
      let stem = String(key.dropFirst("social_".count))
      composed = (
        Self.localized("notif.social.\(stem).title", locale: locale),
        Self.localized("notif.social.\(stem).body", locale: locale)
      )
    case "social_reaction":
      composed = (
        Self.localized("notif.social.reaction.title", locale: locale),
        String(
          format: Self.localized("notif.social.reaction.body", locale: locale), actor, arg)
      )
    case "form_opening_soon":
      composed = (
        Self.localized("notif.form.opening_soon.title", locale: locale),
        Self.localized("notif.form.opening_soon.body", locale: locale)
      )
    case "form_open":
      composed = (
        Self.localized("notif.form.open.title", locale: locale),
        Self.localized("notif.form.open.body", locale: locale)
      )
    // A payment landed on a full form, to the form's managers: `arg` is the form's title only.
    case "form_paid_over_capacity":
      composed = (
        Self.localized("notif.form.paid_over_capacity.title", locale: locale),
        Self.localizedFormat("notif.form.paid_over_capacity.body", arg, locale: locale)
      )
    // The agenda's five. `arg` is the event's title; only `event_proposed` also names the actor.
    case "event_proposed":
      composed = (
        Self.localized("notif.event.proposed.title", locale: locale),
        String(format: Self.localized("notif.event.proposed.body", locale: locale), actor, arg)
      )
    case "event_validated":
      composed = (
        Self.localized("notif.event.validated.title", locale: locale),
        Self.localizedFormat("notif.event.validated.body", arg, locale: locale)
      )
    case "event_rejected":
      composed = (
        Self.localized("notif.event.rejected.title", locale: locale),
        Self.localizedFormat("notif.event.rejected.body", arg, locale: locale)
      )
    case "event_updated":
      composed = (
        Self.localized("notif.event.updated.title", locale: locale),
        Self.localizedFormat("notif.event.updated.body", arg, locale: locale)
      )
    case "event_deleted":
      composed = (
        Self.localized("notif.event.deleted.title", locale: locale),
        Self.localizedFormat("notif.event.deleted.body", arg, locale: locale)
      )
    case "event_pending":
      composed = (
        Self.localized("notif.event.pending.title", locale: locale),
        Self.localizedFormat("notif.event.pending.body", arg, locale: locale)
      )
    default:
      NSLog("[CanariNSE] unknown contentKey=\(key) - keeping the server's own wording")
      composed = nil
    }

    guard let (title, body) = composed else { return }
    content.title = title
    content.body = body
  }

  /// Rewrites a reaction alert: the phone's own sentence, and the CONVERSATION's thread rather
  /// than the coarse `canari_social` one, so it groups with that conversation's notifications.
  ///
  /// Nothing here decrypts, because there is nothing to decrypt: the push carries an id, an emoji
  /// and who reacted. It used to carry 80 characters of the message in clear - the recipient is
  /// the message's AUTHOR, so the device already holds it and never needed a copy.
  private func applyReactionContent(
    userInfo: [AnyHashable: Any],
    content: UNMutableNotificationContent
  ) {
    let emoji = Self.string(userInfo["emoji"]) ?? ""
    let groupId = Self.string(userInfo["groupId"]) ?? ""
    let ctx = loadPushContext()
    let actorName = Self.nonEmpty(Self.string(userInfo["title"])) ?? ""
    if !actorName.isEmpty {
      content.title = actorName
    }
    content.body = Self.localizedFormat("notif.reaction.body", emoji, locale: ctx?.locale)
    if !groupId.isEmpty {
      content.threadIdentifier = groupId
    }
    // The actor's avatar and the badge, exactly as applyMessageContent does them. THIS EXTENSION IS
    // THE PATH THAT RUNS WHEN THE APP IS KILLED, and it used to stop at the sentence - so a
    // reaction arriving on a phone with Canari closed showed a blank icon and left the app-icon
    // count one too high, while the in-app path (canari_push.mm) and Android both did neither.
    var attachedFace = false
    if let ctx = ctx, let actorId = Self.nonEmpty(Self.string(userInfo["senderId"])),
      let avatarUrl = fetchAvatar(ctx: ctx, userId: actorId)
    {
      attachedFace = attachImage(content: content, fileUrl: avatarUrl, identifier: "avatar")
    }
    if !attachedFace {
      attachInitials(content: content, name: actorName)
    }
    applyBadgeCount(content: content, incomingThreadId: content.threadIdentifier)
  }

  /// The picture on a SOCIAL push: an association's logo, or a person's photo.
  ///
  /// A social notification used to carry no image at all, so a post from an association arrived as
  /// a line of text while a MESSAGE from one of its officers arrived with their face on it -
  /// reported by the user on 2026-09-17. The reaction and message paths already did this; this is
  /// the third caller of the same two helpers, not a new mechanism.
  ///
  /// **THE PAYLOAD CARRIES AN ID AND NEVER A LOCATION.** `iconMediaId` is concatenated into the one
  /// public-media route this extension already knows and `iconUserId` goes through the
  /// authenticated avatar proxy, so a push can point this process at exactly two routes on its own
  /// origin and nowhere else. The server enforces the same at the other end (`publicMediaIconId`);
  /// both halves are needed, and this is the one that holds wherever a payload is composed.
  ///
  /// Does nothing when the push names no picture, which is the FORM REMINDER's case: it has no
  /// actor, and an initials disc would put a letter where nobody's name is.
  private func attachSocialIcon(
    userInfo: [AnyHashable: Any],
    content: UNMutableNotificationContent
  ) {
    let mediaId = Self.nonEmpty(Self.string(userInfo["iconMediaId"]))
    let userId = Self.nonEmpty(Self.string(userInfo["iconUserId"]))
    if mediaId == nil && userId == nil { return }
    guard let ctx = loadPushContext() else { return }

    var fileUrl: URL?
    if let mediaId = mediaId {
      fileUrl = fetchPublicMedia(ctx: ctx, mediaId: mediaId)
    } else if let userId = userId {
      fileUrl = fetchAvatar(ctx: ctx, userId: userId)
    }
    if let fileUrl = fileUrl, attachImage(content: content, fileUrl: fileUrl, identifier: "avatar") {
      return
    }
    // A named picture that could not be fetched still falls back to initials, as the message path
    // does: the push said whose it was, so the notification can say so too.
    if let name = Self.nonEmpty(Self.string(userInfo["actorName"])) {
      attachInitials(content: content, name: name)
    }
  }

  /// A notification string from the EXTENSION's own `Localizable.strings`, in the app's language.
  ///
  /// The appex is a separate bundle from the app, so `Bundle.main` here is the extension and cannot
  /// see `canari_iOS/*.lproj`: the table is deliberately duplicated under `canari_NSE/*.lproj`.
  /// That split is the platform's, not a choice.
  ///
  /// `locale` is the Français/English chosen INSIDE Canari, mirrored into `push_context.json`.
  /// `Bundle.main` (French-first) is the fallback and `preferredLocalizations` is deliberately NOT
  /// consulted: it answers for the OS, which is a different setting from the one the user set.
  /// See `CanariLocaleBundle` in `canari_push.mm`, the app-process twin of this.
  private static func localeBundle(_ locale: String?) -> Bundle {
    guard let lang = locale, !lang.isEmpty else { return .main }
    if let path = Bundle.main.path(forResource: lang, ofType: "lproj"),
      let bundle = Bundle(path: path)
    {
      return bundle
    }
    let base = lang.split(separator: "-").first.map(String.init) ?? lang
    if let path = Bundle.main.path(forResource: base, ofType: "lproj"),
      let bundle = Bundle(path: path)
    {
      return bundle
    }
    return .main
  }

  private static func localized(_ key: String, locale: String?) -> String {
    localeBundle(locale).localizedString(forKey: key, value: key, table: nil)
  }

  private static func localizedFormat(_ key: String, _ arg: String, locale: String?) -> String {
    String(format: localized(key, locale: locale), arg)
  }

  override func serviceExtensionTimeWillExpire() {
    // The OS is about to kill the extension: deliver whatever we have (decrypted if
    // we got there, otherwise the server fallback) rather than losing the notification.
    NSLog("[CanariNSE] time expired - delivering best attempt")
    if let handler = contentHandler, let content = bestAttemptContent {
      Self.logFiling(content, via: "expired")
      handler(content)
    }
  }

  /// Delivers the current best-attempt content exactly once.
  private func finish() {
    guard let handler = contentHandler, let content = bestAttemptContent else { return }
    contentHandler = nil
    Self.logFiling(content, via: "finish")
    handler(content)
  }

  /// HOW THE NOTIFICATION IS FILED, for the cross-client rig on a BENCH build only (observable O13,
  /// docs/wiki/cross-client-ios.md): iOS has no channels, so a mention and a plain message differ by
  /// `interruptionLevel`, which nothing outside the process can read off a delivered notification.
  /// `CANARI_BENCH` is set by `ios.yml` for a `local_url` build and never for a store one, which
  /// `.github/scripts/bench-observables.sh` asserts on the archive. Twin: `CanariShowLocalNotification`.
  private static func logFiling(_ content: UNNotificationContent, via: String) {
    #if CANARI_BENCH
      var level = "unavailable"
      if #available(iOS 15.0, *) {
        switch content.interruptionLevel {
        case .passive: level = "passive"
        case .active: level = "active"
        case .timeSensitive: level = "timeSensitive"
        case .critical: level = "critical"
        @unknown default: level = "unknown(\(content.interruptionLevel.rawValue))"
        }
      }
      NSLog(
        "[CanariNSE] filed interruptionLevel=\(level) thread=\(content.threadIdentifier.prefix(8)) via=\(via)"
      )
    #endif
  }

  // MARK: - MLS (direct message / group) --------------------------------------

  private func handleMlsMessage(userInfo: [AnyHashable: Any], content: UNMutableNotificationContent) {
    let groupId = Self.string(userInfo["groupId"]) ?? ""
    let groupName = Self.string(userInfo["groupName"]) ?? ""
    // THE CONVERSATION'S KIND, WHICH `groupName` COULD NOT CARRY. An empty name meant a DM, a group
    // nobody named, and a group row the server could not read - three states as one. `nil` means the
    // push did not say, and a reader must then keep whatever it did before. Android twin:
    // `CanariFirebaseMessagingService`, same key.
    let isGroup: Bool? = Self.string(userInfo["isGroup"]).map { $0 == "true" }
    let senderName = Self.string(userInfo["senderName"]) ?? ""
    let senderId = Self.string(userInfo["senderId"]) ?? ""
    let queuedMessageId = Self.string(userInfo["queuedMessageId"]) ?? ""
    let inlineProto = Self.string(userInfo["proto"]) ?? ""
    // The member's level for this conversation, when it is `mentions` - see `levelDecision`.
    let notifLevel = Self.string(userInfo["notifLevel"])

    guard let ctx = loadPushContext() else {
      NSLog("[CanariNSE] push_context absent - fallback")
      applyMessageContent(
        content: content, senderName: senderName, groupName: groupName,
        // No context means no mirrored locale either, so this one sentence falls back to the main
        // bundle - French. It is the honest answer: nothing on the device knows better here.
        body: Self.fallbackText(senderName: senderName, locale: nil), groupId: groupId,
        senderId: senderId, ctx: nil, media: nil,
        level: Self.levelDecision(level: notifLevel, mentioned: nil, myUserId: nil, groupId: groupId))
      return
    }

    // Resolve the ciphertext: inline when it fit in the payload, else fetch it by id.
    var protoB64 = inlineProto
    if protoB64.isEmpty, !queuedMessageId.isEmpty {
      protoB64 = fetchProtoFromBackend(queuedMessageId: queuedMessageId, ctx: ctx) ?? ""
    }

    var decrypted: DecryptResult?
    if !protoB64.isEmpty {
      decrypted = runDecryptLadder(ctx: ctx, groupId: groupId, senderId: senderId, protoB64: protoB64)
    }

    // Call signaling over MLS (WP-XP-5, killed-app path). Only pre-WP-XP-5 callers send these
    // pushes non-silent (new callers ring via APNs VoIP -> CallKit instead). An invite becomes a
    // time-sensitive ringing banner; control events (hangup/answered/ICE) must never surface as a
    // message - the NSE cannot drop a push (no filtering entitlement), so they deliver blank and
    // additionally clear a previously-shown ring banner for the same callId.
    if let call = decrypted, call.type == "call_invite" {
      applyCallInviteContent(
        content: content, senderName: senderName, groupName: groupName,
        groupId: groupId, callId: call.callId ?? "", hasVideo: call.hasVideo, locale: ctx.locale)
      return
    }
    if let call = decrypted, call.type == "call_control" {
      applyCallControlContent(content: content, callId: call.callId ?? "", ended: call.callEnded)
      return
    }

    let body = decrypted?.text ?? Self.fallbackText(senderName: senderName, locale: ctx.locale)

    // Cache decrypted messages so the app can pre-inject them at boot. Do not cache
    // call signaling or empty fallback bodies. Android twin: writeFcmCache after the
    // call branches.
    if let msg = decrypted, msg.type != "call_invite", msg.type != "call_control" {
      writeFcmCache(
        groupId: groupId, senderId: senderId, senderName: senderName, groupName: groupName,
        isGroup: isGroup, result: msg)
    }

    applyMessageContent(
      content: content, senderName: senderName, groupName: groupName, body: body,
      groupId: groupId, senderId: senderId, ctx: ctx, media: decrypted,
      level: Self.levelDecision(
        level: notifLevel, mentioned: decrypted?.mentionedUserIds, myUserId: ctx.userId,
        groupId: groupId))
  }

  /// How loud one MLS message may be, given the member's level for its conversation.
  ///
  /// THE ONE PLACE THIS EXTENSION DECIDES IT - the twin of Android's `NotificationLevelGate`. `none`
  /// never wakes the extension (the server sends it as a background frame); `mentions` arrives as
  /// `notifLevel=mentions` on an alert the server already made `passive` and soundless, because the
  /// server cannot see who the message names. An extension cannot WITHHOLD an alert push without
  /// Apple's filtering entitlement, which this app does not hold - so the iOS form of "withhold" is
  /// `passive`: filed in the notification centre, no sound, no banner, the screen stays dark.
  ///
  /// THE STATED RULE FOR WHAT CANNOT BE DECIDED (docs/wiki/services/chat-delivery.md): a message
  /// that could not be read, or an account id that could not be loaded, proves no mention - it stays
  /// passive, which is also exactly what iOS shows when this extension never runs at all.
  struct LevelDecision {
    /// The message names this account: break through Focus and ring with the mention trill - which
    /// also raises a `mentions` frame the server sent soundless.
    let mentionsMe: Bool
    /// The conversation is at `mentions` and the message does not prove a mention: stay passive.
    let quiet: Bool
  }

  static func levelDecision(
    level: String?, mentioned: Set<String>?, myUserId: String?, groupId: String
  ) -> LevelDecision {
    let me = myUserId?.lowercased() ?? ""
    let mentionsMe = !me.isEmpty && (mentioned?.contains(me) ?? false)
    guard level == "mentions" else {
      return LevelDecision(mentionsMe: mentionsMe, quiet: false)
    }
    if mentionsMe {
      NSLog("[CanariNSE] [NOTIF] group=\(groupId.prefix(8)) level=mentions and it names me - raised")
      return LevelDecision(mentionsMe: true, quiet: false)
    }
    let why = mentioned == nil || me.isEmpty
      ? "the message could not be read - a mention is not proven"
      : "the message does not mention this account"
    NSLog("[CanariNSE] [NOTIF] group=\(groupId.prefix(8)) level=mentions - kept passive: \(why)")
    return LevelDecision(mentionsMe: false, quiet: true)
  }

  /// Runs the decrypt ladder matching Android (WP-PUSH-2):
  /// 1. direct decrypt;
  /// 2. if the locality could not be established, stop - see `GroupLocality.unknown`;
  /// 3. if the group is already local, in-memory commit catch-up;
  /// 4. if the group is genuinely absent, stop - nothing this extension can wait for joins it.
  private func runDecryptLadder(
    ctx: PushContext, groupId: String, senderId: String, protoB64: String
  ) -> DecryptResult? {
    guard let state = loadMlsState() else {
      NSLog("[CanariNSE] decrypt ladder: MLS state absent group=\(groupId.prefix(8))")
      return nil
    }

    let directJson = decryptProtoJson(
      ctx: ctx, groupId: groupId, senderId: senderId, protoB64: protoB64, state: state)
    var decrypted = Self.parseDecrypted(directJson)
    guard decrypted == nil, !groupId.isEmpty else { return decrypted }

    // REFUSED AT AN EPOCH THIS DEVICE HOLDS: a catch-up builds the NEXT epoch and cannot read it, so
    // none is fetched (`background.rs` `refused_by_mls`). Android twin: `PushDecrypt.RefusedForGood`.
    if Self.refusalReason(directJson) == "mls-refused-for-good" {
      NSLog("[CanariNSE] MLS refused it at an epoch this device holds group=\(groupId.prefix(8)) -> generic fallback, no catch-up")
      return nil
    }

    let locality = groupLocality(groupId: groupId, ctx: ctx)
    NSLog("[CanariNSE] direct decrypt failed group=\(groupId.prefix(8)) locality=\(locality)")

    if locality == .unknown {
      // Nothing was established, so nothing is retried: the catch-up answers an epoch gap, and
      // none has been diagnosed here.
      NSLog("[CanariNSE] locality unknown group=\(groupId.prefix(8)) -> generic fallback")
      return nil
    }

    if locality == .local {
      decrypted = decryptWithCommitCatchup(ctx: ctx, groupId: groupId, senderId: senderId, protoB64: protoB64)
      return decrypted
    }

    // ABSENT: THE GROUP IS NOT JOINED HERE, AND THIS EXTENSION NEVER JOINS ONE - a Welcome is the
    // app's to process. The ladder used to sleep 3 x 1.8 s betting that the app joined meanwhile, a
    // race nobody observed; removed with its Android twin (user, 2026-09-28: "Supprime ce delai").
    NSLog("[CanariNSE] group not joined here group=\(groupId.prefix(8)) -> generic fallback")
    return nil
  }

  /// Ringing banner for a legacy (non-silent) MLS call invite: ringtone-class sound +
  /// time-sensitive interruption so it breaks through Focus like a call should.
  private func applyCallInviteContent(
    content: UNMutableNotificationContent, senderName: String, groupName: String,
    groupId: String, callId: String, hasVideo: Bool, locale: String?
  ) {
    content.title = senderName.isEmpty ? "Canari" : senderName
    content.subtitle = groupName
    // The emoji is not a translation and stays here; the sentence comes from the table, in the
    // language chosen inside Canari. Android twin: notif_incoming_call / notif_incoming_video_call.
    let callKey = hasVideo ? "notif.call.incoming_video" : "notif.call.incoming"
    content.body = "\(hasVideo ? "\u{1f4f9}" : "\u{1f4de}") \(Self.localized(callKey, locale: locale))"
    if #available(iOS 15.2, *) {
      content.sound = .defaultRingtone
    } else {
      content.sound = .default
    }
    if #available(iOS 15.0, *) {
      content.interruptionLevel = .timeSensitive
    }
    if !groupId.isEmpty {
      content.threadIdentifier = groupId
      content.userInfo["deepLink"] =
        "fr.emse.canari://chat/\(groupId)?acceptCall=\(callId)&video=\(hasVideo ? 1 : 0)"
    }
    // Tag with the callId so a later hangup/answered control push can clear this banner.
    if !callId.isEmpty {
      content.userInfo["canariCallId"] = callId
    }
    finish()
  }

  /// Call control (hangup/answered/ICE): deliver a blank, silent content (the NSE cannot suppress
  /// a push) and clear any ringing banner previously shown for the same callId.
  private func applyCallControlContent(
    content: UNMutableNotificationContent, callId: String, ended: Bool
  ) {
    content.title = ""
    content.subtitle = ""
    content.body = ""
    content.sound = nil
    if #available(iOS 15.0, *) {
      content.interruptionLevel = .passive
    }
    guard ended, !callId.isEmpty else {
      finish()
      return
    }
    let center = UNUserNotificationCenter.current()
    center.getDeliveredNotifications { delivered in
      let ringIds = delivered
        .filter { ($0.request.content.userInfo["canariCallId"] as? String) == callId }
        .map { $0.request.identifier }
      if !ringIds.isEmpty {
        center.removeDeliveredNotifications(withIdentifiers: ringIds)
        NSLog("[CanariNSE] cleared \(ringIds.count) ring banner(s) for call \(callId)")
      }
      self.finish()
    }
  }

  /// Parsed decrypt result: the preview text plus the media reference/CEK for a thumbnail (WP-XP-3).
  private struct DecryptResult {
    let text: String
    let messageId: String
    let sentAt: Int64
    let replyTo: String?
    /// "image" | "video" | "audio" | "file" | "reel", as Rust read it. "reel" is a CanaReel sent in
    /// a conversation (WP-RC-7): Rust words its line and withholds its key, so `isImageMedia` is
    /// false for it twice over - no thumbnail, ever.
    let mediaKind: String?
    let mediaId: String?
    let mediaKey: String?
    let mediaIv: String?
    let mimeType: String?
    /// Message kind ("text" | "reply" | "media" | "call_invite" | "call_control" | ...), WP-XP-5.
    let type: String
    /// Call signaling metadata (WP-XP-5), only for `type == "call_invite" | "call_control"`.
    let callId: String?
    let callEnded: Bool
    let hasVideo: Bool
    /// Every user id the WHOLE plaintext mentions (`@[<64 hex>]`), lower-cased, read before `text`
    /// is clamped - a mention past the preview is still a mention.
    let mentionedUserIds: Set<String>
    /// True for an image/GIF message that carries everything needed to fetch + decrypt a thumbnail.
    var isImageMedia: Bool {
      mediaKind == "image" && !(mediaId ?? "").isEmpty && !(mediaKey ?? "").isEmpty
        && !(mediaIv ?? "").isEmpty
    }
  }

  /// The raw JSON of a direct decrypt against the persisted state, read-only - a message, or a
  /// refusal carrying its `reason` - or nil when nothing could be attempted. The ladder reads the
  /// reason to skip a catch-up that cannot help; the seed frame reads it because its answer IS one.
  private func decryptProtoJson(
    ctx: PushContext, groupId: String, senderId: String, protoB64: String, state: Data
  ) -> String? {
    guard !ctx.deviceKeyB64.isEmpty else { return nil }
    guard let cipher = Data(base64Encoded: protoB64, options: .ignoreUnknownCharacters),
      !cipher.isEmpty
    else { return nil }

    let json = state.withUnsafeBytes { statePtr -> String? in
      cipher.withUnsafeBytes { cipherPtr -> String? in
        guard let raw = canari_native_decrypt_message(
          statePtr.bindMemory(to: UInt8.self).baseAddress, state.count,
          ctx.deviceKeyB64, ctx.userId, ctx.deviceId, groupId,
          senderId,
          cipherPtr.bindMemory(to: UInt8.self).baseAddress, cipher.count, ctx.locale)
        else { return nil }
        defer { canari_free_string(raw) }
        return String(cString: raw)
      }
    }
    Self.announceOwnDevicesAdded(json, ctx: ctx, source: "decrypt")
    return json
  }

  /// "A new device was added to your account" (user decision 2026-10-22), from a commit this
  /// extension merged in memory - never from a server message.
  ///
  /// `json` is a native decrypt answer; its `ownDeviceAdded` array holds the keys Rust found to be
  /// this account's owner alerts (`mobile/device_notice.rs`). They are claimed in the ledger the app
  /// shares in the App Group (`canari_native_claim_device_notices`), so a push replaying the same
  /// commit, or the app having shown it already, raises nothing. One local notification for the
  /// keys this call claimed; the app's in-app alert names the device. Android twin:
  /// `CanariFirebaseMessagingService.announceOwnDevicesAdded`.
  private static func announceOwnDevicesAdded(_ json: String?, ctx: PushContext, source: String) {
    guard let json = json, let data = json.data(using: .utf8),
      let dict = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
      let keys = dict["ownDeviceAdded"] as? [String], !keys.isEmpty
    else { return }
    guard let dir = appGroupDir(),
      let keysData = try? JSONSerialization.data(withJSONObject: keys),
      let keysJson = String(data: keysData, encoding: .utf8)
    else {
      NSLog("[CanariNSE] \(source): device(s) added to this account - App Group unavailable, not announced")
      return
    }
    // IN THE FOREGROUND THE APP TELLS IT (its in-app alert), as on Android: nothing is posted and
    // nothing claimed, so the app's own claim stays the first. The app keeps the flag file in the
    // App Group (`CanariSetAppGroupForegroundFlag`); a flag a crash left behind costs this one
    // notification, never the in-app alert.
    if FileManager.default.fileExists(atPath: dir.appendingPathComponent(appInForegroundFile).path) {
      NSLog("[CanariNSE] \(source): device(s) added to this account - the app is in the foreground, it tells")
      return
    }
    guard let raw = canari_native_claim_device_notices(dir.path, keysJson) else {
      NSLog("[CanariNSE] \(source): device-notice claim returned nothing - not announced")
      return
    }
    let claimedJson = String(cString: raw)
    canari_free_string(raw)
    let claimed = (try? JSONSerialization.jsonObject(with: Data(claimedJson.utf8))) as? [String] ?? []
    guard !claimed.isEmpty else {
      NSLog("[CanariNSE] \(source): device(s) added to this account were already announced")
      return
    }
    let content = UNMutableNotificationContent()
    content.title = localized("notif.device.added.title", locale: ctx.locale)
    content.body = localized("notif.device.added.body", locale: ctx.locale)
    content.sound = .default
    // One identifier: a second announcement replaces the first rather than stacking.
    let request = UNNotificationRequest(
      identifier: "canari-new-device", content: content, trigger: nil)
    UNUserNotificationCenter.current().add(request) { error in
      if let error = error {
        NSLog("[CanariNSE] \(source): new-device notification NOT raised: \(error)")
      } else {
        NSLog("[CanariNSE] \(source): \(claimed.count) new device(s) on this account - notified")
      }
    }
  }

  /// Reads the current epoch, fetches the missing ordered commits, and applies them in
  /// memory to decrypt a push that is ahead of the persisted state. Never persists mls.bin.
  private func decryptWithCommitCatchup(
    ctx: PushContext, groupId: String, senderId: String, protoB64: String
  ) -> DecryptResult? {
    Self.parseDecrypted(
      catchupJson(ctx: ctx, groupId: groupId, senderId: senderId, protoB64: protoB64))
  }

  /// The raw JSON of a commit catch-up, as `decryptProtoJson` is to a direct decrypt.
  private func catchupJson(
    ctx: PushContext, groupId: String, senderId: String, protoB64: String
  ) -> String? {
    guard !ctx.deviceKeyB64.isEmpty else { return nil }
    guard let state = loadMlsState() else { return nil }

    let epoch: Int64 = state.withUnsafeBytes { statePtr in
      canari_native_group_epoch(
        statePtr.bindMemory(to: UInt8.self).baseAddress, state.count,
        ctx.deviceKeyB64, ctx.userId, ctx.deviceId, groupId)
    }
    guard epoch >= 0 else {
      NSLog("[CanariNSE] catchup: epoch unknown group=\(groupId)")
      return nil
    }

    guard let commitsJson = fetchCommitsFromBackend(groupId: groupId, sinceEpoch: epoch, ctx: ctx),
      !commitsJson.isEmpty, commitsJson != "[]"
    else {
      NSLog("[CanariNSE] catchup: no commits to apply (epoch=\(epoch))")
      return nil
    }

    guard let cipher = Data(base64Encoded: protoB64, options: .ignoreUnknownCharacters),
      !cipher.isEmpty
    else { return nil }

    let json = state.withUnsafeBytes { statePtr -> String? in
      cipher.withUnsafeBytes { cipherPtr -> String? in
        guard let raw = canari_native_decrypt_message_with_commits(
          statePtr.bindMemory(to: UInt8.self).baseAddress, state.count,
          ctx.deviceKeyB64, ctx.userId, ctx.deviceId, groupId, senderId, commitsJson,
          cipherPtr.bindMemory(to: UInt8.self).baseAddress, cipher.count, ctx.locale)
        else { return nil }
        defer { canari_free_string(raw) }
        return String(cString: raw)
      }
    }
    Self.announceOwnDevicesAdded(json, ctx: ctx, source: "catchup")
    return json
  }

  /// Whether the group exists in the persisted MLS state - or whether that could not be
  /// established. `unknown` is not `absent`: this returned a plain `Bool`, so an unreadable
  /// `mls.bin` or a missing device key both said "the group is not joined here", which sends a
  /// conversation the device has been in for months down the Welcome-race branch. Android twin:
  /// `CanariFirebaseMessagingService.GroupLocality`, where the same conflation was measured
  /// turning a push backlog into a process the OS killed for CPU.
  private enum GroupLocality { case local, absent, unknown }

  /// Loads `mls.bin` read-only, never persists state, and asks for the group's epoch;
  /// epoch >= 0 means joined. Anything that stops short of an epoch answers `.unknown`.
  private func groupLocality(groupId: String, ctx: PushContext) -> GroupLocality {
    guard !groupId.isEmpty else { return .absent }
    guard !ctx.deviceKeyB64.isEmpty else {
      NSLog("[CanariNSE] groupLocality: device key absent group=\(groupId.prefix(8)) -> unknown")
      return .unknown
    }
    guard let state = loadMlsState() else {
      NSLog("[CanariNSE] groupLocality: mls.bin unreadable group=\(groupId.prefix(8)) -> unknown")
      return .unknown
    }
    let epoch: Int64 = state.withUnsafeBytes { statePtr in
      canari_native_group_epoch(
        statePtr.bindMemory(to: UInt8.self).baseAddress, state.count,
        ctx.deviceKeyB64, ctx.userId, ctx.deviceId, groupId)
    }
    NSLog("[CanariNSE] groupLocality: epoch=\(epoch) group=\(groupId.prefix(8))")
    return epoch >= 0 ? .local : .absent
  }

  /// Keeps one native cache file out of iCloud and computer backups. Per FILE, and re-applied
  /// after every write: an atomic write is a new inode renamed over the old one, and the flag does
  /// not survive it. Only the caches are excluded - never their directory, which also holds the
  /// state a restore must bring back. Twin: `CanariExcludeNativeCacheFilesFromBackup`.
  private static func excludeFromBackup(_ url: URL) {
    var target = url
    var values = URLResourceValues()
    values.isExcludedFromBackup = true
    do {
      try target.setResourceValues(values)
    } catch {
      NSLog("[CanariNSE] backupExclusion: ERROR \(url.lastPathComponent) not excluded: \(errorReason(error))")
    }
  }

  /// Writes a decrypted message entry to `fcm_message_cache.ndjson` in the host app's
  /// App Group container, bounded to `maxFcmCacheEntries`. The app drains it into its own
  /// `app_data_dir` copy on the next activation, and `take_fcm_cache` pre-injects
  /// it at boot. Android twin: `CanariFirebaseMessagingService.writeFcmCache`.
  private func writeFcmCache(
    groupId: String, senderId: String, senderName: String, groupName: String, isGroup: Bool?,
    result: DecryptResult
  ) {
    guard !result.messageId.isEmpty else {
      NSLog("[CanariNSE] writeFcmCache: messageId empty -> entry ignored")
      return
    }
    guard let dir = Self.appGroupDir() else {
      NSLog("[CanariNSE] writeFcmCache: App Group container unavailable")
      return
    }

    var entry: [String: Any] = [
      "groupId": groupId,
      "messageId": result.messageId,
      "senderId": senderId,
      "senderName": senderName,
      // The GROUP's name, carried because the app cannot invent it: the web consumer builds a
      // conversation row from this entry, and with nothing here it named the row after the SENDER.
      // A LABEL and nothing more since 2026-09-21 - `isGroup` below is the discriminator it used to
      // double as. Android twin: `writeFcmCache`.
      "groupName": groupName,
      "content": result.text,
      "timestamp": result.sentAt,
      "type": result.type,
    ]
    // OMITTED WHEN THE PUSH DID NOT SAY: an absent key means "no information", which the consumer
    // reads differently from `false`.
    if let isGroup { entry["isGroup"] = isGroup }
    if let replyTo = result.replyTo, !replyTo.isEmpty {
      entry["replyTo"] = replyTo
    }
    if let mediaKind = result.mediaKind, !mediaKind.isEmpty {
      entry["mediaKind"] = mediaKind
    }

    guard let entryData = try? JSONSerialization.data(withJSONObject: entry, options: []),
      let plainLine = String(data: entryData, encoding: .utf8)
    else {
      NSLog("[CanariNSE] writeFcmCache: JSON encoding failed")
      return
    }
    // SEALED BEFORE IT TOUCHES THE DISK, under the install's native cache key (Rust
    // `native_cache`). With no key the entry is NOT written - never in the clear: the message is
    // still on the server, and the app's sync fetches it.
    guard let sealedRaw = canari_native_seal_cache_line(Self.retrieveNativeCacheKey(), plainLine)
    else {
      NSLog("[CanariNSE] writeFcmCache: ERROR no cache key - entry NOT written messageId=\(result.messageId.prefix(8))")
      return
    }
    let entryLine = String(cString: sealedRaw)
    canari_free_string(sealedRaw)

    let fileUrl = dir.appendingPathComponent(Self.fcmCacheFileName)
    Self.fcmCacheLock.lock()
    defer { Self.fcmCacheLock.unlock() }
    do {
      var lines: [String] = []
      if let data = try? Data(contentsOf: fileUrl),
        let text = String(data: data, encoding: .utf8)
      {
        lines = text.components(separatedBy: "\n").filter { !$0.isEmpty }
      }
      while lines.count >= Self.maxFcmCacheEntries {
        lines.removeFirst()
      }
      lines.append(entryLine)
      let body = lines.joined(separator: "\n").appending("\n")
      // Same protection class as the app's mirror: the NSE runs on a locked device, where a
      // file created with the default class cannot be written at all.
      try Data(body.utf8).write(
        to: fileUrl, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
      Self.excludeFromBackup(fileUrl)
      NSLog("[CanariNSE] writeFcmCache: messageId=\(result.messageId.prefix(8)) groupId=\(groupId.prefix(8))")
    } catch {
      NSLog("[CanariNSE] writeFcmCache: failed: \(errorReason(error))")
    }
  }

  /// Fills the notification with the resolved title/subtitle/body + attachment, then delivers.
  private func applyMessageContent(
    content: UNMutableNotificationContent, senderName: String, groupName: String, body: String,
    groupId: String, senderId: String, ctx: PushContext?, media: DecryptResult?,
    level: LevelDecision
  ) {
    let isGroup = !groupName.isEmpty && groupName != senderName
    content.title = isGroup ? groupName : (senderName.isEmpty ? "Canari" : senderName)
    // Inside a group, surface who spoke as a subtitle (flat DMs already have it as the title).
    if isGroup, !senderName.isEmpty {
      content.subtitle = senderName
    }
    // Rendered for DISPLAY only: the mention-of-me check below reads the raw tokens.
    content.body = Self.renderMentions(body, myUserId: ctx?.userId, locale: ctx?.locale)
    // Per-conversation stacking (WP-iOS-7): replaces the single flat thread.
    if !groupId.isEmpty {
      content.threadIdentifier = groupId
      // Quick actions (WP-XP-1): opt this notification into the reply / mark-as-read category.
      // When the app is fully killed the NSE is the ONLY path that builds the visible alert, so
      // without this stamp the action buttons never appear (the app-alive path sets the same id in
      // canari_push.mm CanariShowLocalNotification). Category id must match the one the app
      // registers via CanariRegisterNotificationCategories; iOS retains it across app termination.
      // MLS DM/group only - channels go through handleChannelMessage and get no quick actions.
      content.categoryIdentifier = "canari_message_category"
      // The instant those actions acknowledge. The killed-app path is the ONE that cannot look it
      // up afterwards - `fcm_message_cache.ndjson` is cleared at every boot - so the notification
      // has to carry it. `media` is the decrypted message; without it the actions say nothing
      // rather than substituting a clock (canari_push.mm CanariSendReadWatermark).
      if let sentAt = media?.sentAt, sentAt > 0 {
        content.userInfo["sentAt"] = sentAt
      }
    }
    // No group-summary text here: UNMutableNotificationContent.summaryArgument was deprecated in
    // iOS 15.0 and is ignored by the system, and the deployment target is 18.2 - so there is no
    // reachable version where setting it would do anything. iOS stacks by threadIdentifier and
    // writes the summary line itself. Twin of the same removal in canari_push.mm.
    content.userInfo["deepLink"] =
      groupId.isEmpty ? "fr.emse.canari://chat" : "fr.emse.canari://chat/\(groupId)"

    // @-mention of me (WP-XP-5): decrypted text carries inline `@[uuid]` tokens; when one targets
    // my own userId, elevate to time-sensitive so it breaks through Focus (requires the app's
    // Time Sensitive Notifications entitlement - silently downgraded to .active without it).
    // Read from the WHOLE plaintext's mentions (`DecryptResult.mentionedUserIds`), never the clamped
    // preview, and decided once in `levelDecision`.
    if level.mentionsMe {
      content.interruptionLevel = .timeSensitive
      // The palette-A "mention" trill. Only the extension can choose it: the server cannot read
      // whether a message names its reader, so it sent the "message" one (or none, see below).
      content.sound = UNNotificationSound(named: UNNotificationSoundName(Self.mentionSoundFile))
    } else if level.quiet {
      content.interruptionLevel = .passive
      content.sound = nil
    }
    // A `mentions` frame arrives soundless from the server; a proven mention rings with the trill
    // set just above, which is also how it is raised (`levelDecision` logs that).

    // Attachment priority: a media thumbnail (WP-XP-3) outranks the sender avatar, since iOS shows
    // only the first image attachment as the banner preview. Fall back to the avatar for text/non-image.
    var attached = false
    if let ctx = ctx, let media = media, media.isImageMedia,
      let mediaUrl = fetchAndDecryptMedia(ctx: ctx, media: media)
    {
      attached = attachImage(content: content, fileUrl: mediaUrl, identifier: "media")
    }
    if !attached, let ctx = ctx, !senderId.isEmpty,
      let avatarUrl = fetchAvatar(ctx: ctx, userId: senderId)
    {
      attached = attachImage(content: content, fileUrl: avatarUrl, identifier: "avatar")
    }
    // Last resort, and it must stay last: iOS renders only the first attachment, so a letter
    // replacing the picture the message is about would be a regression rather than a fallback.
    if !attached {
      attachInitials(content: content, name: senderName)
    }
    applyBadgeCount(content: content, incomingThreadId: content.threadIdentifier)
    finish()
  }

  /// Downloads and decrypts an image/GIF blob for a notification thumbnail (WP-XP-3), writing the
  /// plaintext to a unique temp file. The media service stores only opaque AES-256-GCM ciphertext;
  /// the CEK/IV come from the MLS-decrypted MediaMsg (never the server). Fetched via the
  /// PushSecret-authed proxy (2 MB cap) and decrypted natively. Returns a local file URL or nil.
  private func fetchAndDecryptMedia(ctx: PushContext, media: DecryptResult) -> URL? {
    guard let secret = loadPushSecret(), let mediaId = media.mediaId,
      let keyB64 = media.mediaKey, let ivB64 = media.mediaIv
    else { return nil }

    let mid = Self.encode(mediaId)
    let req = Self.encode(ctx.userId)
    let dev = Self.encode(ctx.deviceId)
    let urlStr = "\(ctx.baseUrl)/api/mls/push/media/\(mid)?requesterId=\(req)&deviceId=\(dev)"
    guard let (cipher, status) = syncRequest(method: "GET", urlStr: urlStr, secret: secret, body: nil),
      status == 200, !cipher.isEmpty
    else { return nil }

    let plaintext: Data? = cipher.withUnsafeBytes { cipherPtr -> Data? in
      var outLen: Int = 0
      guard let ptr = canari_native_decrypt_media(
        keyB64, ivB64, cipherPtr.bindMemory(to: UInt8.self).baseAddress, cipher.count, &outLen),
        outLen > 0
      else { return nil }
      defer { canari_free_bytes(ptr, outLen) }
      return Data(bytes: ptr, count: outLen)
    }
    guard let data = plaintext else { return nil }

    let ext = Self.mimeExtension(media.mimeType)
    let tmp = URL(fileURLWithPath: NSTemporaryDirectory())
      .appendingPathComponent("\(UUID().uuidString).\(ext)")
    guard (try? data.write(to: tmp, options: .atomic)) != nil else { return nil }
    NSLog("[CanariNSE] fetchAndDecryptMedia: thumbnail ready (\(data.count)B)")
    return tmp
  }

  // MARK: - Channel (community) message ---------------------------------------

  private func handleChannelMessage(
    userInfo: [AnyHashable: Any], content: UNMutableNotificationContent
  ) {
    let channelId = Self.string(userInfo["channelId"]) ?? ""
    let sentChannelName = Self.nonEmpty(Self.string(userInfo["channelName"]))
    let workspaceName = Self.nonEmpty(Self.string(userInfo["workspaceName"])) ?? ""
    let sessionId = Self.string(userInfo["senderSessionId"]) ?? ""
    // An index of 0 is the first message of every session, so this stays an Optional and the
    // guard below is on `nil` - never on a falsy zero.
    let messageIndex = UInt32(Self.string(userInfo["messageIndex"]) ?? "")
    let ciphertext = Self.string(userInfo["ciphertext"]) ?? ""
    let nonce = Self.string(userInfo["nonce"]) ?? ""
    let senderId = Self.string(userInfo["senderId"]) ?? ""
    // An `@` of me is TOLD here, not inferred: a channel message carries a cleartext
    // `mentionedUserIds` from the sender, so the server computes `mentioned` per recipient (the same
    // fact that honours the `mentions` level). The MLS path has to scan the decrypted text because
    // the server cannot read it - and that scan is impossible anyway when the ciphertext was too
    // large to inline, where this flag still holds.
    let serverSaysMentioned = Self.string(userInfo["mentioned"]) == "true"

    guard !channelId.isEmpty else {
      NSLog("[CanariNSE] handleChannelMessage: channelId missing")
      finish()
      return
    }

    var body: String?
    // Read once: the app language Rust words its own sentences in, and the id a mention may name.
    let ctx = loadPushContext()
    let openable = !ciphertext.isEmpty && !nonce.isEmpty && messageIndex != nil
    // THE MIRROR FIRST, THEN THE FRAME THE MESSAGE CARRIES (channel-encryption section 19). The
    // extension has no second chance at a banner - nothing redraws it once `finish()` runs - and a
    // seed that only arrives on its own silent push does not even wake the extension. The frame is
    // how this banner gets one.
    var seedHeld = openable && graineSeedHeld(channelId: channelId, sessionId: sessionId)
    var seedSource = "mirror"
    if openable, !seedHeld {
      seedHeld = openSeedFrame(userInfo: userInfo, channelId: channelId, sessionId: sessionId)
      seedSource = "frame"
    }
    if seedHeld {
      NSLog("[CanariNSE] handleChannelMessage: seed source=\(seedSource) channel=\(channelId) session=\(sessionId)")
    }
    // RUST READS THE SESSION FROM THE MIRROR ITSELF and applies every rule the app applies to a row
    // - the floor, and under a v2 session the author, the signature and the AAD (channel-encryption
    // section 21.5) - in the one implementation Android shares. `seedHeld` above only says whether
    // the mirror holds the session, which is what decides between the mirror and the frame.
    if openable, let index = messageIndex, seedHeld, let dir = Self.appGroupDir() {
      let signature = Self.string(userInfo["signature"]) ?? ""
      if let raw = canari_native_open_graine_push(
        dir.path, Self.retrieveNativeCacheKey(), channelId, sessionId, index, senderId, nonce,
        ciphertext, signature, ctx?.locale ?? "")
      {
        let json = String(cString: raw)
        canari_free_string(raw)
        body = Self.parseDecryptedText(json)
        if body == nil {
          NSLog(
            "[CanariNSE] handleChannelMessage: not opened reason=\(Self.refusalReason(json) ?? "none") channel=\(channelId) session=\(sessionId)"
          )
        }
      }
    } else {
      NSLog("[CanariNSE] handleChannelMessage: no seed/ciphertext - generic channel=\(channelId)")
    }

    // COUNTED, NOT ONLY LOGGED - the Android twin is `reportBlindBanner`. Never `held` here: nothing
    // redraws a banner once `finish()` runs, so a seed absent now is a blind banner for good.
    if !seedHeld, let ctx = ctx {
      let missing = [
        "seed",
        ciphertext.isEmpty ? "ciphertext" : nil,
        nonce.isEmpty ? "nonce" : nil,
        messageIndex == nil ? "messageIndex" : nil,
      ].compactMap { $0 }
      reportBlindBanner(ctx: ctx, channelId: channelId, missing: missing)
    }
    // The default when the server could not name the salon is a WORD, so it belongs to the table
    // like every other sentence here - it used to be a French literal on both iOS paths.
    let channelName = sentChannelName ?? Self.localized("notif.channel.unnamed", locale: ctx?.locale)
    // `<Communaute> - #<salon>`: a salon name alone is ambiguous, two communities may both have a
    // `#general`. Degrades to the salon alone when the server could not name the workspace. The
    // same format is spelled by the social-service alert title, the Kotlin service and
    // `canari_push.mm`; `channelPushFields.test.ts` holds the four together.
    content.title = workspaceName.isEmpty ? "#\(channelName)" : "\(workspaceName) - #\(channelName)"
    // THE AUTHOR AND THE MENTION ARE THE SERVER'S WORDS until the open proves them, so a blind
    // banner draws neither - see `channelBannerAttribution`.
    let attribution = Self.channelBannerAttribution(
      showsMessage: body != nil, senderId: senderId, serverSaysMentioned: serverSaysMentioned)
    let mentionsMe = attribution.mentionsMe
    // The APNs `sound` is the server's too: it named the mention trill from the same claim.
    if serverSaysMentioned, !mentionsMe {
      content.sound = UNNotificationSound(named: UNNotificationSoundName(Self.messageSoundFile))
    }
    if body == nil, !senderId.isEmpty || serverSaysMentioned {
      NSLog(
        "[CanariNSE] handleChannelMessage: blind banner -> no author, no mention (server named sender=\(senderId.prefix(8)) mentioned=\(serverSaysMentioned)) channel=\(channelId)"
      )
    }
    // The phone's names, read at most once for this banner: the author line and the tokens share it.
    let nameBook = Self.mentionNameBook(myUserId: ctx?.userId)
    content.body =
      body.map {
        Self.renderMentions($0, myUserId: ctx?.userId, locale: ctx?.locale, nameBook: nameBook)
      }
      ?? Self.localizedFormat("notif.channel.message", channelName, locale: ctx?.locale)
    // A salon banner names no author (its title is the salon), so a mention of this reader says WHO
    // in the subtitle - the Android twin puts the same line above the body (WP-MENTION-NAME).
    if mentionsMe {
      content.subtitle = Self.mentionAuthorLine(
        senderId: senderId, nameBook: nameBook, locale: ctx?.locale)
    }
    content.threadIdentifier = "channel_\(channelId)"
    content.userInfo["deepLink"] = "fr.emse.canari://chat/channel_\(channelId)"
    // Same elevation the MLS path gives a mention (applyMessageContent): break through Focus.
    // Requires the app's Time Sensitive Notifications entitlement - silently downgraded to .active
    // without it. iOS has no notification-channel concept, so this is the whole Android twin of
    // posting on `canari_mentions`.
    if mentionsMe, #available(iOS 15.0, *) {
      content.interruptionLevel = .timeSensitive
    }
    // The sender's face, exactly as the MLS path and both Android paths do it, once the open proved
    // who the sender is. No media thumbnail: WP-XP-3 is MLS-only.
    var attachedFace = false
    if let ctx = ctx, let authorId = attribution.authorId,
      let avatarUrl = fetchAvatar(ctx: ctx, userId: authorId)
    {
      attachedFace = attachImage(content: content, fileUrl: avatarUrl, identifier: "avatar")
    }
    // The SALON's letter, not the composed title's - `<Communaute> - #<salon>` would draw the
    // community, or a `#`. Android's channel path makes the same choice for the same reason.
    if !attachedFace {
      attachInitials(content: content, name: channelName)
    }
    applyBadgeCount(content: content, incomingThreadId: content.threadIdentifier)
    finish()
  }

  /// Opens the seed frame a salon push carries and returns whether the mirror now holds THIS
  /// message's session.
  ///
  /// The frame is the MLS message the sender distributed the seed with on the salon's key group, so
  /// it is decrypted as that push would be - read-only, against the persisted state, through the
  /// commit catch-up when the key group is behind (a member joined while the phone was shut, which is
  /// what rotated the session). A key group this device does not hold is SAID and not waited on: it
  /// is not a join in flight, and the extension's budget is seconds. What the frame yields goes
  /// through the one writer (`canari_native_store_graine_seeds`), and the answer is read back from
  /// the MIRROR - a frame for another session opens nothing for this message.
  /// Android twin: `CanariFirebaseMessagingService.openSeedFrame`.
  private func openSeedFrame(userInfo: [AnyHashable: Any], channelId: String, sessionId: String) -> Bool {
    guard let frame = Self.nonEmpty(Self.string(userInfo["seedFrame"])),
      let groupId = Self.nonEmpty(Self.string(userInfo["seedGroupId"]))
    else {
      NSLog("[CanariNSE] openSeedFrame: no frame on this push (a sender older than section 19, or not inlined) channel=\(channelId)")
      return false
    }
    guard let ctx = loadPushContext(), let state = loadMlsState(), let dir = Self.appGroupDir() else {
      NSLog("[CanariNSE] openSeedFrame: push context, MLS state or App Group unavailable group=\(groupId.prefix(8))")
      return false
    }
    // The frame's MLS sender is the salon message's author, who attached it: Rust refuses the frame
    // when the push names anybody else (WP-G2-1b).
    guard let frameSender = Self.nonEmpty(Self.string(userInfo["senderId"])) else {
      NSLog("[CanariNSE] openSeedFrame: the push names no sender group=\(groupId.prefix(8))")
      return false
    }
    var json = decryptProtoJson(
      ctx: ctx, groupId: groupId, senderId: frameSender, protoB64: frame, state: state)
    if Self.refusalReason(json) == "mls-refused" {
      switch groupLocality(groupId: groupId, ctx: ctx) {
      case .local:
        NSLog("[CanariNSE] openSeedFrame: refused group=\(groupId.prefix(8)) locality=local -> commit catch-up")
        json = catchupJson(ctx: ctx, groupId: groupId, senderId: frameSender, protoB64: frame) ?? json
      case .absent:
        // Channel-encryption section 26: Android joins the key group from this push; the extension
        // reads a MIRROR of the app's MLS state and never writes it, so it cannot. The banner stays
        // generic and the app joins the group at its next foreground (its community load).
        NSLog("[CanariNSE] openSeedFrame: refused group=\(groupId.prefix(8)) locality=absent -> this device is not in the salon's key group; the extension does not join, the app joins at its next foreground")
      case .unknown:
        NSLog("[CanariNSE] openSeedFrame: refused group=\(groupId.prefix(8)) locality=unknown -> nothing established")
      }
    }
    // A v1 seed is refused by Rust since the floor reached the v2 writer (channel-encryption 21.7);
    // its own log line reaches no logger in the extension, so the reason is said here.
    let v1Refused = Self.v1RefusedSessions(json)
    if !v1Refused.isEmpty {
      NSLog("[CanariNSE] openSeedFrame: REFUSED v1 seed(s) \(v1Refused.joined(separator: ",")) group=\(groupId.prefix(8)) - a v1 seed is no longer accepted")
    }
    guard let seedsJson = Self.keyMaterialSeeds(json) else {
      NSLog("[CanariNSE] openSeedFrame: frame did not yield key material reason=\(Self.refusalReason(json) ?? "none") group=\(groupId.prefix(8)) channel=\(channelId)")
      return false
    }
    let stored = canari_native_store_graine_seeds(dir.path, Self.retrieveNativeCacheKey(), seedsJson)
    // How many were handed over, so a writer that kept fewer SAYS so: the native side's own
    // reasons go to no logger in the extension. Android twin: `absorbGraineSeeds`.
    let offered = (try? JSONSerialization.jsonObject(with: Data(seedsJson.utf8)) as? [Any])?.count ?? -1
    if offered > 0 && stored < offered {
      NSLog("[CanariNSE] openSeedFrame: ERROR the native writer kept \(stored) of \(offered) seed(s) group=\(groupId.prefix(8))")
    } else {
      NSLog("[CanariNSE] openSeedFrame: stored \(stored) seed(s) group=\(groupId.prefix(8))")
    }
    let held = graineSeedHeld(channelId: channelId, sessionId: sessionId)
    if !held {
      NSLog("[CanariNSE] openSeedFrame: the frame opened and holds no seed for this message's session group=\(groupId.prefix(8)) channel=\(channelId) session=\(sessionId)")
    }
    return held
  }

  /// Replaces the `@[<64 hex>]` mention tokens a decrypted body carries with something readable -
  /// "you" for this device's own user, the NAME the phone already holds for anybody else, and the
  /// word "someone" for an id it has never named - and collapses the run of spaces a token left.
  ///
  /// The names come from the phone's own copy, never from the push or the network
  /// (WP-MENTION-NAME, 2026-10-18): `display_names.json` in the App Group, which the app writes with
  /// every name it has resolved (`store_display_names`). Android twin: `renderMentions`.
  ///
  /// `nameBook` is the banner's one read of those names, shared with `mentionAuthorLine` on the
  /// salon path; nil reads them here, at most once, and only for a token naming somebody else.
  private static func renderMentions(
    _ text: String, myUserId: String?, locale: String?,
    nameBook: (() -> [String: Any]?)? = nil
  ) -> String {
    guard text.contains("@["),
      let regex = try? NSRegularExpression(pattern: "@\\[([0-9a-fA-F]{64})\\]")
    else { return text }
    let me = myUserId?.lowercased()
    let ns = text as NSString
    let book = nameBook ?? mentionNameBook(myUserId: me)
    var named = 0
    var unknown = 0
    var out = ""
    var cursor = 0
    for match in regex.matches(in: text, range: NSRange(location: 0, length: ns.length)) {
      out += ns.substring(with: NSRange(location: cursor, length: match.range.location - cursor))
      let id = ns.substring(with: match.range(at: 1)).lowercased()
      if me != nil && id == me {
        out += "@" + localized("notif.mention.you", locale: locale)
      } else {
        if let name = book()?[id] as? String, !name.isEmpty {
          named += 1
          out += "@" + name
        } else {
          unknown += 1
          out += "@" + localized("notif.mention.someone", locale: locale)
        }
      }
      cursor = match.range.location + match.range.length
    }
    out += ns.substring(from: cursor)
    if named + unknown > 0 {
      NSLog("[CanariNSE] [MENTION_NAME] named=\(named) unknown=\(unknown)")
    }
    return out.replacingOccurrences(of: "[ \\t]{2,}", with: " ", options: .regularExpression)
  }

  /// The phone's names for one banner: `display_names.json` read on the first call only, so the
  /// author line and the tokens of one banner cost one file read, and a banner needing neither none.
  private static func mentionNameBook(myUserId: String?) -> () -> [String: Any]? {
    var names: [String: Any]?
    var read = false
    return {
      if !read {
        names = loadMentionNames(myUserId: myUserId?.lowercased())
        read = true
      }
      return names
    }
  }

  /// What a salon banner may say about WHO wrote it (2026-10-22). The push's `senderId` and
  /// `mentioned` are the server's words, and only the open proves the author (under a v2 session,
  /// channel-encryption section 21.5). So a banner showing the decrypted text draws the author's
  /// face and "<name> mentioned you" and takes the time-sensitive level; a BLIND banner draws none
  /// of it - the salon's initials and the generic line. Android twin: `ChannelBannerAttribution`.
  static func channelBannerAttribution(
    showsMessage: Bool, senderId: String, serverSaysMentioned: Bool
  ) -> (authorId: String?, mentionsMe: Bool) {
    guard showsMessage else { return (nil, false) }
    return (senderId.isEmpty ? nil : senderId, serverSaysMentioned)
  }

  /// "Alice mentioned you" for a salon banner that mentions this reader (WP-MENTION-NAME,
  /// 2026-10-18): the AUTHOR, named from the phone's own copy of names under the same owner rule as
  /// the tokens, and "Someone" when the phone has never named them. Never from the push, which
  /// carries only `senderId`. Salon only: an MLS banner already names its sender. Android twin:
  /// `mentionAuthorLine`.
  private static func mentionAuthorLine(
    senderId: String, nameBook: () -> [String: Any]?, locale: String?
  ) -> String {
    let id = senderId.lowercased()
    let name = id.isEmpty ? nil : (nameBook()?[id] as? String).flatMap { $0.isEmpty ? nil : $0 }
    NSLog("[CanariNSE] [MENTION_NAME] author named=\(name != nil)")
    // The placeholder opens the sentence in both languages, so the word is capitalised there.
    let someone = localized("notif.mention.someone", locale: locale)
    let who = name ?? (someone.prefix(1).uppercased() + someone.dropFirst())
    return localizedFormat("notif.social.mention.title", who, locale: locale)
  }

  /// The `names` map of `display_names.json` in the App Group, or nil when it cannot be used:
  /// absent, unreadable, or written for another account than `myUserId` (one file per install, and
  /// two accounts may sign in on one phone).
  private static func loadMentionNames(myUserId: String?) -> [String: Any]? {
    guard let me = myUserId, let dir = appGroupDir() else { return nil }
    guard let data = try? Data(contentsOf: dir.appendingPathComponent("display_names.json")) else {
      NSLog("[CanariNSE] [MENTION_NAME] no display_names.json - every other mention is 'someone'")
      return nil
    }
    guard let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
      NSLog("[CanariNSE] [MENTION_NAME] display_names.json unreadable")
      return nil
    }
    guard (root["userId"] as? String)?.lowercased() == me else {
      NSLog("[CanariNSE] [MENTION_NAME] display_names.json belongs to another account - not used")
      return nil
    }
    return root["names"] as? [String: Any]
  }

  /// The `reason` of a refusal from `background.rs`, or nil for anything that is not one.
  private static func refusalReason(_ json: String?) -> String? {
    guard let json = json, let data = json.data(using: .utf8),
      let dict = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
      (dict["ok"] as? Bool) != true
    else { return nil }
    return dict["reason"] as? String
  }

  /// The sessions whose v1 seed Rust refused in a `graine-key-material` answer (`v1Refused`).
  private static func v1RefusedSessions(_ json: String?) -> [String] {
    guard let json = json, let data = json.data(using: .utf8),
      let dict = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
      let ids = dict["v1Refused"] as? [Any]
    else { return [] }
    return ids.compactMap { $0 as? String }
  }

  /// The `seeds` array of a `graine-key-material` answer, re-serialised for the native writer.
  private static func keyMaterialSeeds(_ json: String?) -> String? {
    guard refusalReason(json) == "graine-key-material",
      let json = json, let data = json.data(using: .utf8),
      let dict = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
      let seeds = dict["seeds"] as? [Any],
      let out = try? JSONSerialization.data(withJSONObject: seeds)
    else { return nil }
    return String(data: out, encoding: .utf8)
  }

  /// Whether the mirrored graine_seeds.json holds a Graine session - asked of Rust, which alone
  /// opens the sealed file (`native_cache`), so the seed never enters Swift.
  ///
  /// The mirror is BOUNDED to the newest sessions per channel, so a miss on an old session is
  /// expected rather than a fault: the banner degrades to the generic body, which is the same
  /// outcome an oversized ciphertext already produces. An unreadable mirror reads as a miss, and
  /// says so.
  private func graineSeedHeld(channelId: String, sessionId: String) -> Bool {
    guard !sessionId.isEmpty, let dir = Self.appGroupDir() else { return false }
    let held = canari_native_graine_seed_held(
      dir.path, Self.retrieveNativeCacheKey(), channelId, sessionId)
    if held < 0 {
      NSLog("[CanariNSE] graineSeedHeld: ERROR the seed mirror is unreadable channel=\(channelId)")
    } else if held == 0 {
      NSLog("[CanariNSE] graineSeedHeld: miss channel=\(channelId) session=\(sessionId)")
    }
    return held == 1
  }

  /// The install's native cache key (Rust `native_cache`), base64, from the Keychain item the app
  /// creates at bootstrap (`CanariEnsureNativeCacheKey`) and shares with this extension through
  /// the App Group access group. `""` when absent or unreadable - which Rust treats as "write
  /// nothing, read nothing sealed", never as a reason to write in the clear.
  private static func retrieveNativeCacheKey() -> String {
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: "fr.emse.canari",
      kSecAttrAccount as String: "mls_bg_key_\(nativeCacheKeyAlias)",
      kSecAttrAccessGroup as String: appGroupId,
      kSecReturnData as String: true,
      kSecMatchLimit as String: kSecMatchLimitOne,
    ]
    var item: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &item)
    guard status == errSecSuccess, let data = item as? Data, data.count == 32 else {
      NSLog("[CanariNSE] retrieveNativeCacheKey: ERROR no key (status=\(status))")
      return ""
    }
    // RAW bytes, like the device key's item: re-encoded, never read as UTF-8.
    return data.base64EncodedString()
  }

  // MARK: - Badge (WP-XP-2) ---------------------------------------------------

  /// Sets `content.badge` to the number of distinct unread conversations: the chat conversations
  /// already delivered plus the incoming one. Runs inside the extension (killed app), so it writes
  /// the badge onto the outgoing content - the app-process path uses `setBadgeCount` instead (see
  /// canari_push.mm `CanariUpdateAppBadge`). A conversation is keyed by its per-conversation thread
  /// (NSE deliveries) or the stable request id (flat "canari_messages" in-app deliveries).
  private func applyBadgeCount(content: UNMutableNotificationContent, incomingThreadId: String) {
    let center = UNUserNotificationCenter.current()
    let sem = DispatchSemaphore(value: 0)
    var keys = Set<String>()
    center.getDeliveredNotifications { delivered in
      for n in delivered {
        let thread = n.request.content.threadIdentifier
        let deepLink = (n.request.content.userInfo["deepLink"] as? String) ?? ""
        let isChat = thread == "canari_messages" || deepLink.hasPrefix("fr.emse.canari://chat")
        guard isChat else { continue }
        keys.insert(thread == "canari_messages" ? n.request.identifier : thread)
      }
      sem.signal()
    }
    _ = sem.wait(timeout: .now() + 2.0)
    if !incomingThreadId.isEmpty {
      keys.insert(incomingThreadId)
    }
    content.badge = NSNumber(value: keys.count)
    NSLog("[CanariNSE] applyBadgeCount: badge=\(keys.count)")
  }

  // MARK: - Shared App Group state --------------------------------------------

  /// Push context mirrored from push_context.json (device key, ids, backend base url).
  private struct PushContext {
    let deviceKeyB64: String
    let userId: String
    let deviceId: String
    let baseUrl: String
    /// The language CHOSEN IN THE APP ("fr" / "en"), mirrored from the WebView, which is not
    /// running when a push arrives. NOT `preferredLocalizations`, which answers for the OS - two
    /// different settings, and an app set to English on a French phone was writing French.
    /// Empty on a device that has not opened the app since this shipped.
    let locale: String
  }

  private static func appGroupDir() -> URL? {
    FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroupId)
  }

  private func loadMlsState() -> Data? {
    guard let dir = Self.appGroupDir() else { return nil }
    return try? Data(contentsOf: dir.appendingPathComponent(Self.mlsBinFile))
  }

  private func loadPushContext() -> PushContext? {
    guard let dir = Self.appGroupDir(),
      let data = try? Data(contentsOf: dir.appendingPathComponent(Self.pushContextFile)),
      let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    else { return nil }
    let userId = json["userId"] as? String ?? ""
    let deviceId = json["deviceId"] as? String ?? ""
    let baseUrl = json["baseUrl"] as? String ?? ""
    guard !userId.isEmpty, !deviceId.isEmpty, !baseUrl.isEmpty else { return nil }
    // WP-SEC-1: the device key is no longer in the JSON; source it from the Keychain.
    // Ordering constraint: the account name needs userId + deviceId from the JSON, so
    // parse the JSON first, then hit the Keychain. An empty key means the Keychain is
    // unavailable — the push falls back to the generic text (acceptable one-push cost).
    let deviceKeyB64 = Self.retrieveDeviceKey(userId: userId, deviceId: deviceId) ?? ""
    let locale = json["locale"] as? String ?? ""
    return PushContext(
      deviceKeyB64: deviceKeyB64, userId: userId, deviceId: deviceId, baseUrl: baseUrl,
      locale: locale)
  }

  /// WP-SEC-1: retrieves the MLS device key from the background-accessible Keychain item
  /// (AfterFirstUnlockThisDeviceOnly, no .userPresence, shared via group.fr.emse.canari).
  /// Returns the base64-encoded key, or nil if absent. Mirror of the ObjC
  /// CanariRetrieveDeviceKey in canari_push.mm.
  private static func retrieveDeviceKey(userId: String, deviceId: String) -> String? {
    guard !userId.isEmpty, !deviceId.isEmpty else { return nil }
    let alias = "mls_device_key_\(userId)_\(deviceId)"
    let account = "mls_bg_key_\(alias)"
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: "fr.emse.canari",
      kSecAttrAccount as String: account,
      kSecReturnData as String: true,
      kSecMatchLimit as String: kSecMatchLimitOne,
    ]
    var item: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &item)
    guard status == errSecSuccess, let data = item as? Data, !data.isEmpty else { return nil }
    // The item holds the RAW 32 key bytes: storeKeyBytes base64-decodes its argument
    // before writing, and getKeyBytes base64-encodes on the way back out. Decoding this
    // as UTF-8 would fail on almost every key and silently yield no key at all.
    return data.base64EncodedString()
  }

  /// Push bearer secret, mirrored to the container by the app. Only needed for the
  /// backend fetch paths (omitted proto, commit catch-up, avatar); the common inline
  /// decrypt works without it.
  private func loadPushSecret() -> String? {
    guard let dir = Self.appGroupDir(),
      let raw = try? String(contentsOf: dir.appendingPathComponent(Self.pushSecretFile), encoding: .utf8)
    else { return nil }
    let secret = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    return secret.isEmpty ? nil : secret
  }

  // MARK: - Backend fetches (best-effort, short timeout) ----------------------

  private func fetchProtoFromBackend(queuedMessageId: String, ctx: PushContext) -> String? {
    guard let secret = loadPushSecret() else { return nil }
    let q = Self.encode(queuedMessageId)
    let u = Self.encode(ctx.userId)
    let d = Self.encode(ctx.deviceId)
    let urlStr =
      "\(ctx.baseUrl)/api/mls/push/fetch-proto?messageId=\(q)&userId=\(u)&deviceId=\(d)"
    guard let (data, status) = syncRequest(method: "GET", urlStr: urlStr, secret: secret, body: nil),
      status == 200,
      let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
      let proto = json["proto"] as? String, !proto.isEmpty
    else { return nil }
    return proto
  }

  /// POST /api/mls/push/commits {userId,deviceId,groupId,sinceEpoch} -> {commits:[{proto}]}.
  /// Returns a JSON array of the ordered base64 commit protos, the exact shape
  /// canari_native_decrypt_message_with_commits expects. Mirror of CanariFetchCommitsFromBackend.
  private func fetchCommitsFromBackend(groupId: String, sinceEpoch: Int64, ctx: PushContext) -> String? {
    guard let secret = loadPushSecret() else { return nil }
    let urlStr = "\(ctx.baseUrl)/api/mls/push/commits"
    let payload: [String: Any] = [
      "userId": ctx.userId, "deviceId": ctx.deviceId, "groupId": groupId, "sinceEpoch": sinceEpoch,
    ]
    guard let body = try? JSONSerialization.data(withJSONObject: payload),
      // NestJS @Post returns 201 by default; accept both.
      let (data, status) = syncRequest(method: "POST", urlStr: urlStr, secret: secret, body: body),
      status == 200 || status == 201,
      let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
      let commits = json["commits"] as? [[String: Any]]
    else { return nil }

    let protos = commits.compactMap { ($0["proto"] as? String).flatMap { $0.isEmpty ? nil : $0 } }
    guard let out = try? JSONSerialization.data(withJSONObject: protos) else { return nil }
    return String(data: out, encoding: .utf8)
  }

  /// POST /api/mls/push/blind-banner: tells the server a salon banner went up without its plaintext,
  /// and which term it lacked. Best-effort - the banner is up either way, and the count is a rate.
  private func reportBlindBanner(ctx: PushContext, channelId: String, missing: [String]) {
    guard let secret = loadPushSecret() else {
      NSLog("[CanariNSE] reportBlindBanner: no push secret - the blind banner goes uncounted channel=\(channelId)")
      return
    }
    let payload: [String: Any] = [
      "userId": ctx.userId, "deviceId": ctx.deviceId, "channelId": channelId,
      "platform": "ios", "missing": missing, "held": false,
    ]
    guard let body = try? JSONSerialization.data(withJSONObject: payload) else { return }
    let status = syncRequest(
      method: "POST", urlStr: "\(ctx.baseUrl)/api/mls/push/blind-banner", secret: secret, body: body)?.1
    NSLog("[CanariNSE] reportBlindBanner: HTTP \(status.map(String.init) ?? "none") channel=\(channelId) missing=\(missing.joined(separator: ","))")
  }

  /// Fetches the sender avatar, caching it in the container. Returns a local file URL.
  private func fetchAvatar(ctx: PushContext, userId: String) -> URL? {
    return cachedRemoteFile(name: "avatar_\(Self.sanitizeFilename(userId)).jpg") {
      guard let secret = self.loadPushSecret() else { return nil }
      let user = Self.encode(userId)
      let req = Self.encode(ctx.userId)
      let dev = Self.encode(ctx.deviceId)
      return (
        "\(ctx.baseUrl)/api/mls/push/avatar/\(user)?requesterId=\(req)&deviceId=\(dev)", secret
      )
    }
  }

  /// Downloads a PUBLIC media object - an association logo - for a notification attachment.
  ///
  /// Unauthenticated on purpose: `/api/media/public/:id` is the route an `<img>` on a signed-out
  /// page already uses, so this extension has no credential to present and needs none. That is why
  /// it is a SEPARATE function from `fetchAvatar` rather than a flag on it: which of the two routes
  /// to call is decided by the payload's own field, never guessed from the shape of a string.
  private func fetchPublicMedia(ctx: PushContext, mediaId: String) -> URL? {
    let safe = Self.sanitizeFilename(mediaId)
    return cachedRemoteFile(name: "assologo_\(safe).jpg") {
      ("\(ctx.baseUrl)/api/media/public/\(safe)", nil)
    }
  }

  /// ONE PATH FROM A URL TO A NOTIFICATION IMAGE: the 24h app-group cache, then the fetch.
  ///
  /// Extracted from `fetchAvatar` when the association logo became a second caller. `request` is a
  /// closure rather than two parameters so that a cache HIT costs nothing it does not need - the
  /// avatar route reads the PushSecret out of the Keychain to build its URL, and paying for that
  /// on a hit is what the original ordering was careful to avoid.
  ///
  /// - Parameter request: the URL to fetch and the PushSecret to present, or nil for a public
  ///   route. Returning nil abandons the fetch: the credential is missing, not the file.
  private func cachedRemoteFile(
    name: String,
    request: () -> (urlStr: String, secret: String?)?
  ) -> URL? {
    guard let dir = Self.appGroupDir() else { return nil }
    let cacheUrl = dir.appendingPathComponent(name)

    if let attrs = try? FileManager.default.attributesOfItem(atPath: cacheUrl.path),
      let modified = attrs[.modificationDate] as? Date,
      Date().timeIntervalSince(modified) < 24 * 60 * 60
    {
      return cacheUrl
    }

    guard let (urlStr, secret) = request(),
      let (data, status) = syncRequest(method: "GET", urlStr: urlStr, secret: secret, body: nil),
      status == 200,
      (try? data.write(to: cacheUrl, options: .atomic)) != nil
    else { return nil }
    return cacheUrl
  }

  /// Copies an image file to a unique temp file and attaches it as the notification's preview (an
  /// attachment URL is consumed/moved by the OS, so we never hand it a shared cache file directly).
  /// Preserves the source extension so iOS infers the type (jpg/png/gif/webp). Returns true on success.
  @discardableResult
  private func attachImage(
    content: UNMutableNotificationContent, fileUrl: URL, identifier: String
  ) -> Bool {
    let ext = fileUrl.pathExtension.isEmpty ? "jpg" : fileUrl.pathExtension
    let tmp = URL(fileURLWithPath: NSTemporaryDirectory())
      .appendingPathComponent("\(UUID().uuidString).\(ext)")
    do {
      try FileManager.default.copyItem(at: fileUrl, to: tmp)
      let attachment = try UNNotificationAttachment(identifier: identifier, url: tmp, options: nil)
      content.attachments = [attachment]
      return true
    } catch {
      NSLog("[CanariNSE] attachImage error: \(errorReason(error))")
      return false
    }
  }

  /// Attaches the initials disc for `name`, when nothing better could be attached.
  ///
  /// Deliberately silent about failure: an icon is decoration, and a notification with no image is
  /// the state this whole helper exists to improve on - never a reason to lose the notification.
  private func attachInitials(content: UNMutableNotificationContent, name: String) {
    guard let url = Self.initialsImageUrl(name: name) else { return }
    _ = attachImage(content: content, fileUrl: url, identifier: "avatar")
    // `attachImage` copies into its own temp file because the OS consumes an attachment's URL, so
    // ours has done its job and would otherwise sit in the container until the OS swept it.
    try? FileManager.default.removeItem(at: url)
  }

  /// A `kInitialsSize` indigo disc carrying the first letter of `name`, written to a temp PNG.
  ///
  /// The appex is a separate bundle and shares no code with the app, so this is a deliberate copy
  /// of `CanariInitialsImagePath` in `canari_push.mm` - same size, same colour, same ratio, so the
  /// killed-app path and the in-app path cannot drift into two different-looking notifications.
  /// Android's twin is `generateInitialsBitmap` at 96 px: an Android large icon is a small square,
  /// an iOS attachment is rendered at banner size.
  ///
  /// The letter is a COMPOSED CHARACTER, so a name starting with an emoji or a combining accent is
  /// not cut in half. Android takes the first UTF-16 unit and has that flaw.
  private static func initialsImageUrl(name: String) -> URL? {
    let letter = name.first.map { String($0).uppercased() } ?? "?"
    let format = UIGraphicsImageRendererFormat.default()
    format.scale = 1
    format.opaque = false
    let size = kInitialsSize
    let renderer = UIGraphicsImageRenderer(size: CGSize(width: size, height: size), format: format)
    let image = renderer.image { _ in
      UIColor(red: 0x63 / 255.0, green: 0x66 / 255.0, blue: 0xf1 / 255.0, alpha: 1.0).setFill()
      UIBezierPath(ovalIn: CGRect(x: 0, y: 0, width: size, height: size)).fill()
      let attrs: [NSAttributedString.Key: Any] = [
        .font: UIFont.systemFont(ofSize: size * kInitialsLetterRatio, weight: .semibold),
        .foregroundColor: UIColor.white,
      ]
      let textSize = letter.size(withAttributes: attrs)
      letter.draw(
        at: CGPoint(x: (size - textSize.width) / 2.0, y: (size - textSize.height) / 2.0),
        withAttributes: attrs)
    }
    guard let png = image.pngData() else {
      NSLog("[CanariNSE] initialsImage: PNG encoding failed - notification goes out without an icon")
      return nil
    }
    let url = URL(fileURLWithPath: NSTemporaryDirectory())
      .appendingPathComponent("initials-\(UUID().uuidString).png")
    do {
      try png.write(to: url, options: .atomic)
    } catch {
      NSLog("[CanariNSE] initialsImage: write failed: \(errorReason(error))")
      return nil
    }
    return url
  }

  /// Blocking HTTP request with a short timeout (the extension has a hard ~30s budget).
  /// Returns (body, status) or nil on transport error.
  ///
  /// `secret` is optional because one route needs none: `/api/media/public/:id` is what a
  /// signed-out browser fetches. A nil sends NO `Authorization` header rather than an empty one -
  /// a header the proxy would then have to reason about.
  private func syncRequest(method: String, urlStr: String, secret: String?, body: Data?) -> (Data, Int)? {
    guard let url = URL(string: urlStr) else { return nil }
    var req = URLRequest(url: url)
    req.httpMethod = method
    if let secret = secret {
      req.setValue("PushSecret \(secret)", forHTTPHeaderField: "Authorization")
    }
    if let body = body {
      req.httpBody = body
      req.setValue("application/json", forHTTPHeaderField: "Content-Type")
    }
    req.timeoutInterval = 5.0

    let sem = DispatchSemaphore(value: 0)
    var result: (Data, Int)?
    let task = URLSession.shared.dataTask(with: req) { data, response, _ in
      if let data = data, let http = response as? HTTPURLResponse {
        result = (data, http.statusCode)
      }
      sem.signal()
    }
    task.resume()
    _ = sem.wait(timeout: .now() + 6.0)
    return result
  }

  // MARK: - Helpers -----------------------------------------------------------

  /// Parses a `{"ok":true,"text":...,"mediaKind":...}` decrypt result into a DecryptResult (text
  /// clamped, plus the media reference/CEK for a thumbnail). nil on failure or empty text.
  private static func parseDecrypted(_ json: String?) -> DecryptResult? {
    guard let json = json, let data = json.data(using: .utf8),
      let dict = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
      (dict["ok"] as? Bool) == true
    else { return nil }
    let type = (dict["type"] as? String) ?? "text"
    // Call signaling (WP-XP-5) legitimately decrypts to an empty text ("call_control");
    // any other kind without a preview is unrenderable -> nil (generic fallback).
    let isCall = type == "call_invite" || type == "call_control"
    guard var text = dict["text"] as? String, !text.isEmpty || isCall else { return nil }
    let mentioned = Self.mentionedUserIds(in: text)
    if text.count > maxPreviewLength {
      text = String(text.prefix(maxPreviewLength))
    }
    let nonEmpty: (String) -> String? = { (dict[$0] as? String).flatMap { $0.isEmpty ? nil : $0 } }
    let sentAt: Int64
    if let raw = dict["sentAt"] as? NSNumber {
      sentAt = raw.int64Value
    } else if let raw = dict["sentAt"] as? String, let v = Int64(raw) {
      sentAt = v
    } else {
      sentAt = Int64(Date().timeIntervalSince1970 * 1000)
    }
    return DecryptResult(
      text: text, messageId: nonEmpty("messageId") ?? "",
      sentAt: sentAt, replyTo: nonEmpty("replyTo"), mediaKind: nonEmpty("mediaKind"), mediaId: nonEmpty("mediaId"),
      mediaKey: nonEmpty("mediaKey"), mediaIv: nonEmpty("mediaIv"), mimeType: nonEmpty("mimeType"),
      type: type, callId: nonEmpty("callId"), callEnded: (dict["callEnded"] as? Bool) ?? false,
      hasVideo: (dict["hasVideo"] as? Bool) ?? false, mentionedUserIds: mentioned)
  }

  /// The user ids a plaintext mentions: the `@[<64 hex>]` token every client writes, lower-cased.
  static func mentionedUserIds(in text: String) -> Set<String> {
    guard let re = try? NSRegularExpression(pattern: "@\\[([0-9a-fA-F]{64})\\]") else { return [] }
    let range = NSRange(text.startIndex..., in: text)
    var ids = Set<String>()
    for match in re.matches(in: text, range: range) {
      if let r = Range(match.range(at: 1), in: text) { ids.insert(text[r].lowercased()) }
    }
    return ids
  }

  /// Convenience for the channel path, which needs only the preview text.
  private static func parseDecryptedText(_ json: String?) -> String? {
    parseDecrypted(json)?.text
  }

  /// Maps a media MIME type to a file extension so iOS infers the attachment type.
  private static func mimeExtension(_ mime: String?) -> String {
    switch mime {
    case "image/png": return "png"
    case "image/gif": return "gif"
    case "image/webp": return "webp"
    default: return "jpg"
    }
  }

  private static func fallbackText(senderName: String, locale: String?) -> String {
    senderName.isEmpty
      ? localized("notif.message.encrypted", locale: locale)
      : localizedFormat("notif.message.from", senderName, locale: locale)
  }

  private static func string(_ value: Any?) -> String? { value as? String }

  private static func nonEmpty(_ value: String?) -> String? {
    guard let value = value, !value.isEmpty else { return nil }
    return value
  }

  private static func encode(_ s: String) -> String {
    s.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? s
  }

  /// Mirrors CanariAvatarCachePath: keep [A-Za-z0-9_-], replace the rest with '_', cap 40.
  private static func sanitizeFilename(_ userId: String) -> String {
    let allowed = Set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-")
    var out = ""
    for ch in userId {
      if out.count >= 40 { break }
      out.append(allowed.contains(ch) ? ch : "_")
    }
    return out
  }
}
