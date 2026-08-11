import Security
import UserNotifications

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
/// extension never writes mls.bin.
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
  private static let channelKeysFile = "channel_keys.json"
  private static let pushSecretFile = "push_secret.txt"

  /// Cap the decrypted preview length, matching the 200-char clamp the in-app path uses.
  private static let maxPreviewLength = 200

  /// FCM message cache file: the app pre-injects these entries at boot via
  /// `read_and_clear_fcm_cache`, so a message decrypted while the app was killed shows up
  /// without waiting for the full MLS sync. Android twin:
  /// `CanariFirebaseMessagingService.writeFcmCache`.
  ///
  /// Written into the **App Group container**, not the extension's own Application Support:
  /// an app extension has its own data container, so the `app_data_dir` path the Android
  /// service and `read_and_clear_fcm_cache` share resolves, inside this process, to a
  /// directory the app can never read. The App Group is the only storage the two processes
  /// have in common - it is already where `mls.bin` is read from. `CanariDrainAppGroupFcmCache`
  /// moves the entries into the app's own file on the next activation.
  private static let fcmCacheFileName = "fcm_message_cache.ndjson"

  /// Maximum number of entries kept in `fcm_message_cache.ndjson`.
  private static let maxFcmCacheEntries = 50

  /// Welcome-race retry constants. Mirror of Android `WELCOME_RACE_RETRIES` /
  /// `WELCOME_RACE_RETRY_DELAY_MS`: when a message push arrives before the concurrent
  /// Welcome push has finished joining the group, retry briefly before falling back.
  private static let welcomeRaceRetries = 3
  private static let welcomeRaceRetryDelayMs = 1_800

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
    case "social", "form_reminder", "channel_read":
      // Not encrypted (or a silent control frame): the payload already carries the
      // final title/body, so leave the alert untouched and deliver as-is.
      finish()
    default:
      handleMlsMessage(userInfo: userInfo, content: content)
    }
  }

  override func serviceExtensionTimeWillExpire() {
    // The OS is about to kill the extension: deliver whatever we have (decrypted if
    // we got there, otherwise the server fallback) rather than losing the notification.
    NSLog("[CanariNSE] time expired - delivering best attempt")
    if let handler = contentHandler, let content = bestAttemptContent {
      handler(content)
    }
  }

  /// Delivers the current best-attempt content exactly once.
  private func finish() {
    guard let handler = contentHandler, let content = bestAttemptContent else { return }
    contentHandler = nil
    handler(content)
  }

  // MARK: - MLS (direct message / group) --------------------------------------

  private func handleMlsMessage(userInfo: [AnyHashable: Any], content: UNMutableNotificationContent) {
    let groupId = Self.string(userInfo["groupId"]) ?? ""
    let groupName = Self.string(userInfo["groupName"]) ?? ""
    let senderName = Self.string(userInfo["senderName"]) ?? ""
    let senderId = Self.string(userInfo["senderId"]) ?? ""
    let queuedMessageId = Self.string(userInfo["queuedMessageId"]) ?? ""
    let inlineProto = Self.string(userInfo["proto"]) ?? ""

    guard let ctx = loadPushContext() else {
      NSLog("[CanariNSE] push_context absent - fallback")
      applyMessageContent(
        content: content, senderName: senderName, groupName: groupName,
        body: Self.fallbackText(senderName: senderName), groupId: groupId, senderId: senderId,
        ctx: nil, media: nil)
      return
    }

    // Resolve the ciphertext: inline when it fit in the payload, else fetch it by id.
    var protoB64 = inlineProto
    if protoB64.isEmpty, !queuedMessageId.isEmpty {
      protoB64 = fetchProtoFromBackend(queuedMessageId: queuedMessageId, ctx: ctx) ?? ""
    }

    var decrypted: DecryptResult?
    if !protoB64.isEmpty {
      decrypted = runDecryptLadder(ctx: ctx, groupId: groupId, protoB64: protoB64)
    }

    // Call signaling over MLS (WP-XP-5, killed-app path). Only pre-WP-XP-5 callers send these
    // pushes non-silent (new callers ring via APNs VoIP -> CallKit instead). An invite becomes a
    // time-sensitive ringing banner; control events (hangup/answered/ICE) must never surface as a
    // message - the NSE cannot drop a push (no filtering entitlement), so they deliver blank and
    // additionally clear a previously-shown ring banner for the same callId.
    if let call = decrypted, call.type == "call_invite" {
      applyCallInviteContent(
        content: content, senderName: senderName, groupName: groupName,
        groupId: groupId, callId: call.callId ?? "", hasVideo: call.hasVideo)
      return
    }
    if let call = decrypted, call.type == "call_control" {
      applyCallControlContent(content: content, callId: call.callId ?? "", ended: call.callEnded)
      return
    }

    let body = decrypted?.text ?? Self.fallbackText(senderName: senderName)

    // Cache decrypted messages so the app can pre-inject them at boot. Do not cache
    // call signaling or empty fallback bodies. Android twin: writeFcmCache after the
    // call branches.
    if let msg = decrypted, msg.type != "call_invite", msg.type != "call_control" {
      writeFcmCache(groupId: groupId, senderId: senderId, senderName: senderName, result: msg)
    }

    applyMessageContent(
      content: content, senderName: senderName, groupName: groupName, body: body,
      groupId: groupId, senderId: senderId, ctx: ctx, media: decrypted)
  }

  /// Runs the decrypt ladder matching Android (WP-PUSH-2):
  /// 1. direct decrypt;
  /// 2. if the locality could not be established, stop - see `GroupLocality.unknown`;
  /// 3. if the group is already local, in-memory commit catch-up;
  /// 4. if the group is genuinely absent, retry the Welcome race up to 3 times, then a final
  ///    catch-up if the group appeared in the meantime.
  private func runDecryptLadder(ctx: PushContext, groupId: String, protoB64: String) -> DecryptResult? {
    guard let state = loadMlsState() else {
      NSLog("[CanariNSE] decrypt ladder: MLS state absent group=\(groupId.prefix(8))")
      return nil
    }

    var decrypted = decryptProto(ctx: ctx, groupId: groupId, protoB64: protoB64, state: state)
    guard decrypted == nil, !groupId.isEmpty else { return decrypted }

    let locality = groupLocality(groupId: groupId, ctx: ctx)
    NSLog("[CanariNSE] direct decrypt failed group=\(groupId.prefix(8)) locality=\(locality)")

    if locality == .unknown {
      // Nothing was established, so nothing is retried: the catch-up answers an epoch gap and the
      // race answers a pending join, and neither has been diagnosed here.
      NSLog("[CanariNSE] locality unknown group=\(groupId.prefix(8)) -> generic fallback")
      return nil
    }

    if locality == .local {
      decrypted = decryptWithCommitCatchup(ctx: ctx, groupId: groupId, protoB64: protoB64)
      return decrypted
    }

    // Welcome/message race: the concurrent Welcome push may be joining the group when
    // this message arrives. Retry briefly so the first message of a new conversation
    // produces a real notification instead of a generic fallback.
    var raceAttempt = 0
    while decrypted == nil && raceAttempt < Self.welcomeRaceRetries {
      raceAttempt += 1
      let delay = Double(Self.welcomeRaceRetryDelayMs) / 1000.0
      NSLog("[CanariNSE] welcome-race retry \(raceAttempt)/\(Self.welcomeRaceRetries) sleep=\(delay)s group=\(groupId.prefix(8))")
      Thread.sleep(forTimeInterval: delay)
      decrypted = decryptProto(ctx: ctx, groupId: groupId, protoB64: protoB64, state: state)
      if decrypted == nil {
        NSLog("[CanariNSE] welcome-race retry \(raceAttempt)/\(Self.welcomeRaceRetries) still failed group=\(groupId.prefix(8))")
      }
    }

    // The group may have appeared during the race (Welcome processed by the app or
    // another extension invocation). Last-resort catch-up before falling back.
    if decrypted == nil && groupLocality(groupId: groupId, ctx: ctx) == .local {
      NSLog("[CanariNSE] group appeared during welcome-race, attempting catch-up group=\(groupId.prefix(8))")
      decrypted = decryptWithCommitCatchup(ctx: ctx, groupId: groupId, protoB64: protoB64)
    }

    return decrypted
  }

  /// Ringing banner for a legacy (non-silent) MLS call invite: ringtone-class sound +
  /// time-sensitive interruption so it breaks through Focus like a call should.
  private func applyCallInviteContent(
    content: UNMutableNotificationContent, senderName: String, groupName: String,
    groupId: String, callId: String, hasVideo: Bool
  ) {
    content.title = senderName.isEmpty ? "Canari" : senderName
    content.subtitle = groupName
    content.body = hasVideo ? "\u{1f4f9} Appel vid\u{00e9}o entrant" : "\u{1f4de} Appel entrant"
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
    /// True for an image/GIF message that carries everything needed to fetch + decrypt a thumbnail.
    var isImageMedia: Bool {
      mediaKind == "image" && !(mediaId ?? "").isEmpty && !(mediaKey ?? "").isEmpty
        && !(mediaIv ?? "").isEmpty
    }
  }

  /// Decrypts the ciphertext directly against the persisted state. Read-only.
  private func decryptProto(
    ctx: PushContext, groupId: String, protoB64: String, state: Data
  ) -> DecryptResult? {
    guard !ctx.deviceKeyB64.isEmpty else { return nil }
    guard let cipher = Data(base64Encoded: protoB64, options: .ignoreUnknownCharacters),
      !cipher.isEmpty
    else { return nil }

    let json = state.withUnsafeBytes { statePtr -> String? in
      cipher.withUnsafeBytes { cipherPtr -> String? in
        guard let raw = canari_native_decrypt_message(
          statePtr.bindMemory(to: UInt8.self).baseAddress, state.count,
          ctx.deviceKeyB64, ctx.userId, ctx.deviceId, groupId,
          cipherPtr.bindMemory(to: UInt8.self).baseAddress, cipher.count)
        else { return nil }
        defer { canari_free_string(raw) }
        return String(cString: raw)
      }
    }
    return Self.parseDecrypted(json)
  }

  /// Reads the current epoch, fetches the missing ordered commits, and applies them in
  /// memory to decrypt a push that is ahead of the persisted state. Never persists mls.bin.
  private func decryptWithCommitCatchup(
    ctx: PushContext, groupId: String, protoB64: String
  ) -> DecryptResult? {
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
          ctx.deviceKeyB64, ctx.userId, ctx.deviceId, groupId, commitsJson,
          cipherPtr.bindMemory(to: UInt8.self).baseAddress, cipher.count)
        else { return nil }
        defer { canari_free_string(raw) }
        return String(cString: raw)
      }
    }
    return Self.parseDecrypted(json)
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

  /// Writes a decrypted message entry to `fcm_message_cache.ndjson` in the host app's
  /// App Group container, bounded to `maxFcmCacheEntries`. The app drains it into its own
  /// `app_data_dir` copy on the next activation, and `read_and_clear_fcm_cache` pre-injects
  /// it at boot. Android twin: `CanariFirebaseMessagingService.writeFcmCache`.
  private func writeFcmCache(
    groupId: String, senderId: String, senderName: String, result: DecryptResult
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
      "content": result.text,
      "timestamp": result.sentAt,
      "type": result.type,
    ]
    if let replyTo = result.replyTo, !replyTo.isEmpty {
      entry["replyTo"] = replyTo
    }
    if let mediaKind = result.mediaKind, !mediaKind.isEmpty {
      entry["mediaKind"] = mediaKind
    }

    guard let entryData = try? JSONSerialization.data(withJSONObject: entry, options: []),
      let entryLine = String(data: entryData, encoding: .utf8)
    else {
      NSLog("[CanariNSE] writeFcmCache: JSON encoding failed")
      return
    }

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
      NSLog("[CanariNSE] writeFcmCache: messageId=\(result.messageId.prefix(8)) groupId=\(groupId.prefix(8))")
    } catch {
      NSLog("[CanariNSE] writeFcmCache: failed: \(error.localizedDescription)")
    }
  }

  /// Fills the notification with the resolved title/subtitle/body + attachment, then delivers.
  private func applyMessageContent(
    content: UNMutableNotificationContent, senderName: String, groupName: String, body: String,
    groupId: String, senderId: String, ctx: PushContext?, media: DecryptResult?
  ) {
    let isGroup = !groupName.isEmpty && groupName != senderName
    content.title = isGroup ? groupName : (senderName.isEmpty ? "Canari" : senderName)
    // Inside a group, surface who spoke as a subtitle (flat DMs already have it as the title).
    if isGroup, !senderName.isEmpty {
      content.subtitle = senderName
    }
    content.body = body
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
    if #available(iOS 15.0, *), let uid = ctx?.userId, !uid.isEmpty,
      body.range(of: "@[\(uid)]", options: .caseInsensitive) != nil
    {
      content.interruptionLevel = .timeSensitive
    }

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
      _ = attachImage(content: content, fileUrl: avatarUrl, identifier: "avatar")
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
    let channelName = Self.nonEmpty(Self.string(userInfo["channelName"])) ?? "Salon"
    let keyVersion = Self.string(userInfo["keyVersion"]) ?? ""
    let ciphertext = Self.string(userInfo["ciphertext"]) ?? ""
    let nonce = Self.string(userInfo["nonce"]) ?? ""

    guard !channelId.isEmpty else {
      NSLog("[CanariNSE] handleChannelMessage: channelId missing")
      finish()
      return
    }

    var body: String?
    if !ciphertext.isEmpty, !nonce.isEmpty,
      let keyB64 = lookupChannelKey(channelId: channelId, keyVersion: keyVersion)
    {
      if let raw = canari_native_decrypt_channel_message(keyB64, nonce, ciphertext) {
        let json = String(cString: raw)
        canari_free_string(raw)
        body = Self.parseDecryptedText(json)
      }
    } else {
      NSLog("[CanariNSE] handleChannelMessage: no key/ciphertext - generic channel=\(channelId)")
    }

    content.title = "#\(channelName)"
    content.body = body ?? "Nouveau message dans #\(channelName)"
    content.threadIdentifier = "channel_\(channelId)"
    content.userInfo["deepLink"] = "fr.emse.canari://chat/channel_\(channelId)"
    applyBadgeCount(content: content, incomingThreadId: content.threadIdentifier)
    finish()
  }

  /// Looks up the raw base64 epoch key for a channel/keyVersion in the mirrored
  /// channel_keys.json. Shape: { "<channelId>": { "<keyVersion>": "<keyB64>" } }.
  private func lookupChannelKey(channelId: String, keyVersion: String) -> String? {
    guard let dir = Self.appGroupDir() else { return nil }
    let url = dir.appendingPathComponent(Self.channelKeysFile)
    guard let data = try? Data(contentsOf: url),
      let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
      let byChannel = json[channelId] as? [String: Any],
      let key = byChannel[keyVersion] as? String, !key.isEmpty
    else {
      NSLog("[CanariNSE] lookupChannelKey: miss channel=\(channelId) v=\(keyVersion)")
      return nil
    }
    return key
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
    return PushContext(deviceKeyB64: deviceKeyB64, userId: userId, deviceId: deviceId, baseUrl: baseUrl)
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

  /// Fetches the sender avatar, caching it in the container. Returns a local file URL.
  private func fetchAvatar(ctx: PushContext, userId: String) -> URL? {
    guard let dir = Self.appGroupDir() else { return nil }
    let safe = Self.sanitizeFilename(userId)
    let cacheUrl = dir.appendingPathComponent("avatar_\(safe).jpg")

    if let attrs = try? FileManager.default.attributesOfItem(atPath: cacheUrl.path),
      let modified = attrs[.modificationDate] as? Date,
      Date().timeIntervalSince(modified) < 24 * 60 * 60
    {
      return cacheUrl
    }

    guard let secret = loadPushSecret() else { return nil }
    let user = Self.encode(userId)
    let req = Self.encode(ctx.userId)
    let dev = Self.encode(ctx.deviceId)
    let urlStr =
      "\(ctx.baseUrl)/api/mls/push/avatar/\(user)?requesterId=\(req)&deviceId=\(dev)"
    guard let (data, status) = syncRequest(method: "GET", urlStr: urlStr, secret: secret, body: nil),
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
      NSLog("[CanariNSE] attachImage error: \(error.localizedDescription)")
      return false
    }
  }

  /// Blocking HTTP request with a bearer PushSecret and a short timeout (the extension
  /// has a hard ~30s budget). Returns (body, status) or nil on transport error.
  private func syncRequest(method: String, urlStr: String, secret: String, body: Data?) -> (Data, Int)? {
    guard let url = URL(string: urlStr) else { return nil }
    var req = URLRequest(url: url)
    req.httpMethod = method
    req.setValue("PushSecret \(secret)", forHTTPHeaderField: "Authorization")
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
      hasVideo: (dict["hasVideo"] as? Bool) ?? false)
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

  private static func fallbackText(senderName: String) -> String {
    senderName.isEmpty ? "Vous avez recu un message chiffre" : "Nouveau message de \(senderName)"
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
