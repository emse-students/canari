import Foundation
import UniformTypeIdentifiers
import os

/// What a capture came to, for the confirmation the extension shows.
enum ShareCaptureOutcome {
    /// A manifest now waits in the App Group: `files` kept, `refused` not.
    case handedOver(files: Int, refused: Int)
    /// Nothing was kept; the refusals were handed over alone, so the app can say so.
    case keptNothing(refused: Int)
    /// The share carried nothing at all.
    case empty
    /// The share could not be handed over (said in the log).
    case failed
}

/// Copies what another app shared INTO Canari into the `group.fr.emse.canari` App Group, and leaves
/// the manifest the app carries over - the iOS twin of Android's `IncomingShare.kt`.
///
/// WHY THE APP GROUP. An extension has a container of its own and can write neither the app's data
/// directory nor its cache. So the copies go to `<group>/shared_inbox/<share id>/` and the manifest to
/// `<group>/pending_share.json`, with Android's schema (`id, epoch, text, files[{path,name,mime,size}],
/// refused`). Each `path` is the copy's App Group path: the app MOVES the directory under its own
/// cache and REWRITES every path to the moved file (`commands/app_group_share.rs`), so the page reads
/// exactly what it reads on Android.
///
/// WHY A COPY, AT ONCE, STREAMED. The file a provider hands over lives only as long as its completion
/// handler, and the page reads much later, after the PIN. Each item is copied by file representation
/// in 64 KiB chunks - never loaded whole: an extension is killed past roughly 120 MB of memory, and a
/// shared video is far larger.
///
/// ONE CAPTURE, ONE TAKER. The whole capture holds an exclusive `flock` on
/// `<group>/shared_inbox.lock`; the app only ever TRIES it, so it never moves or sweeps a share being
/// copied. The share EPOCH (`<group>/share_epoch`, written by every sign-out) is read once the lock is
/// held, and stamped on the manifest: a capture that started before a sign-out lands stale and is
/// never offered to the next account (docs/wiki/frontend/sharing.md).
///
/// Nothing is SENT from here. The page asks the member where it goes, and the composer sends.
final class ShareCapture {
    static let appGroupId = "group.fr.emse.canari"
    static let pendingFile = "pending_share.json"
    static let inboxDir = "shared_inbox"
    static let epochFile = "share_epoch"
    static let lockFile = "shared_inbox.lock"
    /// The Darwin notification a running app imports on (`canari_ios.mm`).
    static let readyNotification = "fr.emse.canari.share-ready"
    private static let bufferSize = 64 * 1024

    private let log = Logger(subsystem: "fr.emse.canari", category: "share")

    /// What one attachment is taken as.
    private enum Kind {
        case webURL
        case text
        case file(String)
        case unsupported
    }

    /// Set when the system takes the capture's time back: the copy stops at the next chunk or
    /// attachment, deletes what it wrote, and releases the lock (`run`).
    private final class Cancellation {
        private let lock = NSLock()
        private var cancelled = false
        private var started = false
        private var current: Progress?

        var isCancelled: Bool { lock.lock(); defer { lock.unlock() }; return cancelled }

        /// Marks the work as begun; false when the expiry came first, and the work must not begin.
        func start() -> Bool { lock.lock(); defer { lock.unlock() }; started = !cancelled; return started }

        /// Cancels; true when the work had begun, so the caller must wait for it to clean up.
        func cancel() -> Bool {
            lock.lock()
            cancelled = true
            let progress = current
            let wasStarted = started
            lock.unlock()
            // A load waiting on the provider ends with an error instead of holding the capture.
            progress?.cancel()
            return wasStarted
        }

        /// The provider load under way, so a cancel can end it.
        func track(_ progress: Progress?) {
            lock.lock()
            current = progress
            let now = cancelled
            lock.unlock()
            if now { progress?.cancel() }
        }
    }

    private let cancellation = Cancellation()

    /// Copies the share and hands it over. BLOCKING: call it off the main thread. `target` is the
    /// suggestion the member picked (`c:<conversation id>`, already checked by
    /// `ShareRules.suggestedTarget`), written into the manifest as Android writes it.
    ///
    /// UNDER AN EXPIRING ACTIVITY. An extension suspended while it holds a lock on a file in a
    /// shared container is killed by the system (`0xdead10cc`), and a copy of a long video can
    /// outlast the time the extension is given. So the capture runs inside
    /// `performExpiringActivity`: on expiry it is cancelled, deletes its partial directory and
    /// releases the lock BEFORE the expiry handler returns. The app is told a share is ready
    /// (`postReady`) only AFTER the lock is released, or its try-lock import would answer Busy.
    func run(items: [NSExtensionItem], target: String?) -> ShareCaptureOutcome {
        let finished = DispatchGroup()
        finished.enter()
        var outcome: ShareCaptureOutcome = .failed
        ProcessInfo.processInfo.performExpiringActivity(withReason: "Copying a share into Canari") { expired in
            if expired {
                if self.cancellation.cancel() {
                    self.log.error("the system is taking the capture's time back - cancelling it")
                    // Wait for the capture to delete its copies and release the lock: returning
                    // here lets the system suspend the process.
                    finished.wait()
                } else {
                    self.log.error("the system gave the capture no time - nothing was copied")
                    finished.leave()
                }
                return
            }
            guard self.cancellation.start() else { return }
            outcome = self.captureLocked(items: items, target: target)
            finished.leave()
        }
        finished.wait()
        switch outcome {
        case .handedOver, .keptNothing:
            postReady()
        case .empty, .failed:
            break
        }
        return outcome
    }

    /// The capture itself, under the App Group lock (released when this returns).
    private func captureLocked(items: [NSExtensionItem], target: String?) -> ShareCaptureOutcome {
        let providers = items.flatMap { $0.attachments ?? [] }
        log.info("share received: \(items.count) item(s), \(providers.count) attachment(s)")
        guard let container = FileManager.default.containerURL(
            forSecurityApplicationGroupIdentifier: ShareCapture.appGroupId)
        else {
            log.error("the App Group container is unavailable (entitlement missing?)")
            return .failed
        }
        let lockPath = container.appendingPathComponent(ShareCapture.lockFile).path
        let lockFd = open(lockPath, O_CREAT | O_RDWR, 0o644)
        if lockFd < 0 {
            log.error("the share lock could not be opened: errno \(errno)")
            return .failed
        }
        defer {
            flock(lockFd, LOCK_UN)
            close(lockFd)
        }
        if flock(lockFd, LOCK_EX) != 0 {
            log.error("the share lock could not be taken: errno \(errno)")
            return .failed
        }
        // READ ONCE THE LOCK IS HELD, so a sign-out that found the lock free and advanced the epoch
        // is seen, and one that found it held leaves this capture stale.
        let epoch = readEpoch(container)
        let shareId = UUID().uuidString
        let inbox = container.appendingPathComponent(ShareCapture.inboxDir, isDirectory: true)
        let dir = inbox.appendingPathComponent(shareId, isDirectory: true)
        do {
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        } catch {
            log.error("the share directory could not be made: \(error.localizedDescription)")
            return .failed
        }
        // The inbox holds only share copies (never the App Group's push or MLS files), so the
        // DIRECTORY is excluded; set on every capture, as a sweep may have removed and remade it.
        excludeFromBackup(inbox)

        var texts: [String] = []
        var textBytes = 0
        var refused = 0
        for item in items {
            let typed = item.attributedContentText?.string.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            if typed.isEmpty {
                continue
            }
            if fitsTextCeiling(typed, what: "the item's text", held: &textBytes) {
                texts.append(typed)
            } else {
                refused += 1
            }
        }
        var files: [[String: Any]] = []
        var kept: Int64 = 0
        var fileIndex = 0
        for (index, provider) in providers.enumerated() {
            if cancellation.isCancelled {
                break
            }
            switch classify(provider) {
            case .webURL:
                if let url = loadWebURL(provider, index: index),
                   fitsTextCeiling(url, what: "attachment \(index)", held: &textBytes) {
                    texts.append(url)
                } else {
                    refused += 1
                }
            case .text:
                if let text = loadText(provider, index: index),
                   fitsTextCeiling(text, what: "attachment \(index)", held: &textBytes) {
                    texts.append(text)
                } else {
                    refused += 1
                }
            case .file(let typeId):
                let position = fileIndex
                fileIndex += 1
                if position >= ShareRules.maxFiles {
                    log.warning("file \(position) refused: past \(ShareRules.maxFiles) files")
                    refused += 1
                    continue
                }
                let ceiling = ShareRules.nextFileCeiling(keptSoFar: kept)
                if ceiling <= 0 {
                    log.warning("file \(position) refused: the share already holds \(ShareRules.maxTotalBytes / 1024 / 1024) MB")
                    refused += 1
                    continue
                }
                if let copied = copyFile(provider, typeId: typeId, index: position, into: dir,
                                         ceiling: ceiling, container: container) {
                    kept += copied.size
                    files.append(copied.entry)
                } else {
                    refused += 1
                }
            case .unsupported:
                log.warning("attachment \(index) refused: no type Canari can take")
                refused += 1
            }
        }

        // CANCELLED: nothing is handed over, and nothing of this share stays in the App Group.
        if cancellation.isCancelled {
            deleteDir(dir, why: "capture cancelled by the system")
            return .failed
        }
        let text = joinTexts(texts)
        if text.isEmpty && files.isEmpty {
            deleteDir(dir, why: "share kept nothing")
            if refused == 0 {
                log.info("the share carried nothing")
                return .empty
            }
            return reportRefusals(container, refused: refused, epoch: epoch) ? .keptNothing(refused: refused) : .failed
        }
        var payload: [String: Any] = [
            "id": shareId,
            "epoch": epoch,
            "text": text,
            "files": files,
            "refused": refused,
        ]
        // The suggestion the member picked (sharing lot S5), under Android's key: the app's import
        // carries every key through unchanged, and the page reads it as a hint.
        if let target = target {
            payload["target"] = target
        }
        // CLAIMED, NOT PEEKED AT, exactly as on Android - and an older session's share never replaces
        // a newer one's.
        let replaced = claimPending(container)
        if let older = replaced, epochOf(older) > epoch {
            _ = writePending(container, older)
            deleteDir(dir, why: "share from a signed-out session (epoch \(epoch))")
            return .failed
        }
        guard writePending(container, payload) else {
            deleteDir(dir, why: "share not handed over")
            if let older = replaced {
                _ = writePending(container, older)
            }
            return .failed
        }
        // Handed over: the older share nobody imported is now unreachable, and only now is it gone.
        if let older = replaced, let olderId = older["id"] as? String, ShareCapture.isSafeId(olderId),
           olderId != shareId {
            log.info("a share nobody imported was replaced by a newer one")
            deleteDir(inbox.appendingPathComponent(olderId, isDirectory: true), why: "replaced share")
        }
        log.info("share ready: \(files.count) file(s), \(kept) bytes, \(refused) refused")
        return .handedOver(files: files.count, refused: refused)
    }

    /// Whether `id` can name a directory under the inbox: the UUID shape this writes, nothing else.
    static func isSafeId(_ id: String) -> Bool {
        return !id.isEmpty && id.count <= 64
            && id.unicodeScalars.allSatisfy { CharacterSet.alphanumerics.contains($0) && $0.isASCII || $0 == "-" }
    }

    /// Movies and pictures first (Photos registers both kinds), then a web link (taken as text: a
    /// FILE URL obtained as an item is never opened - see `loadWebURL`), then plain text, then any
    /// data with a file representation.
    private func classify(_ provider: NSItemProvider) -> Kind {
        if provider.hasItemConformingToTypeIdentifier(UTType.movie.identifier) {
            return .file(UTType.movie.identifier)
        }
        if provider.hasItemConformingToTypeIdentifier(UTType.image.identifier) {
            return .file(UTType.image.identifier)
        }
        if provider.hasItemConformingToTypeIdentifier(UTType.url.identifier)
            && !provider.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier) {
            return .webURL
        }
        if provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier)
            && !provider.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier) {
            return .text
        }
        let dataType = provider.registeredTypeIdentifiers.first { identifier in
            guard let type = UTType(identifier) else { return false }
            return type.conforms(to: .data) && !type.conforms(to: .url)
        }
        if let dataType = dataType {
            return .file(dataType)
        }
        return .unsupported
    }

    /// A web link, as text. A FILE URL is refused, never opened: it would let the sender name a path
    /// this extension can read - the App Group, where the app mirrors its push secrets - and copy it
    /// into a share (the confused deputy Android refuses `file://` for).
    private func loadWebURL(_ provider: NSItemProvider, index: Int) -> String? {
        let done = DispatchSemaphore(value: 0)
        var link: String?
        provider.loadItem(forTypeIdentifier: UTType.url.identifier, options: nil) { item, error in
            defer { done.signal() }
            var url = item as? URL
            if url == nil, let data = item as? Data {
                url = URL(dataRepresentation: data, relativeTo: nil)
            }
            guard let found = url else {
                self.log.warning("attachment \(index) refused: its link is unreadable (\(error?.localizedDescription ?? "no item"))")
                return
            }
            if found.isFileURL {
                self.log.warning("attachment \(index) refused: a file URL is never opened")
                return
            }
            link = found.absoluteString
        }
        done.wait()
        return link
    }

    /// Plain text, as text.
    private func loadText(_ provider: NSItemProvider, index: Int) -> String? {
        let done = DispatchSemaphore(value: 0)
        var text: String?
        provider.loadItem(forTypeIdentifier: UTType.plainText.identifier, options: nil) { item, error in
            defer { done.signal() }
            if let string = item as? String {
                text = string
            } else if let attributed = item as? NSAttributedString {
                text = attributed.string
            } else if let data = item as? Data {
                text = String(data: data, encoding: .utf8)
            }
            if text == nil {
                let reason = error?.localizedDescription ?? "no text"
                self.log.warning("attachment \(index) refused: its text is unreadable (\(reason))")
            }
        }
        done.wait()
        let trimmed = text?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? nil : trimmed
    }

    /// Whether `part` still fits the share's text ceiling (`ShareRules.maxTextBytes`), counted into
    /// `held` when it does. A part that does not is refused - said here, counted by the caller - so
    /// the manifest the app and the page read whole stays bounded. The provider hands a text over
    /// whole, so this bounds what is KEPT, not what was loaded.
    private func fitsTextCeiling(_ part: String, what: String, held: inout Int) -> Bool {
        let size = part.utf8.count
        if held + size > ShareRules.maxTextBytes {
            log.warning("\(what, privacy: .public) refused: its text (\(size) bytes) passes the share's \(ShareRules.maxTextBytes / 1024) KiB of text")
            return false
        }
        held += size
        return true
    }

    /// Copies one file representation into `dir`. Returns its manifest entry and size, or nil when it
    /// was refused (unreadable, inside the App Group, over `ceiling`; a partial copy is deleted).
    private func copyFile(_ provider: NSItemProvider, typeId: String, index: Int, into dir: URL,
                          ceiling: Int64, container: URL) -> (entry: [String: Any], size: Int64)? {
        let done = DispatchSemaphore(value: 0)
        var copied: (entry: [String: Any], size: Int64)?
        let suggested = provider.suggestedName
        let progress = provider.loadFileRepresentation(forTypeIdentifier: typeId) { url, error in
            defer { done.signal() }
            guard let url = url else {
                self.log.warning("file \(index) refused: no file representation (\(error?.localizedDescription ?? "none"))")
                return
            }
            // The file exists only until this handler returns, so it is copied HERE.
            copied = self.copy(from: url, suggestedName: suggested, typeId: typeId, index: index,
                               into: dir, ceiling: ceiling, container: container)
        }
        cancellation.track(progress)
        done.wait()
        cancellation.track(nil)
        return copied
    }

    private func copy(from source: URL, suggestedName: String?, typeId: String, index: Int, into dir: URL,
                      ceiling: Int64, container: URL) -> (entry: [String: Any], size: Int64)? {
        let resolved = source.resolvingSymlinksInPath().standardizedFileURL.path
        let group = container.resolvingSymlinksInPath().standardizedFileURL.path
        if resolved == group || resolved.hasPrefix(group + "/") {
            log.warning("file \(index) refused: it lies inside Canari's own App Group")
            return nil
        }
        let ext = source.pathExtension
        let mime = UTType(filenameExtension: ext)?.preferredMIMEType
            ?? UTType(typeId)?.preferredMIMEType
            ?? "application/octet-stream"
        var rawName = suggestedName ?? source.deletingPathExtension().lastPathComponent
        if !ext.isEmpty && (rawName as NSString).pathExtension.isEmpty {
            rawName += "." + ext
        }
        let name = SharedFileName.sanitise(rawName, mime: mime)
        // The index prefix keeps two files with the same name apart on disk; the page is told the
        // name alone.
        let target = dir.appendingPathComponent("\(index)_\(name)")
        guard FileManager.default.createFile(atPath: target.path, contents: nil) else {
            log.warning("file \(index) refused: its copy could not be created")
            return nil
        }
        do {
            let input = try FileHandle(forReadingFrom: source)
            defer { try? input.close() }
            let output = try FileHandle(forWritingTo: target)
            defer { try? output.close() }
            var total: Int64 = 0
            while true {
                let chunk: Data? = try autoreleasepool {
                    try input.read(upToCount: ShareCapture.bufferSize)
                }
                guard let data = chunk, !data.isEmpty else { break }
                if cancellation.isCancelled {
                    try? output.close()
                    try? FileManager.default.removeItem(at: target)
                    log.warning("file \(index) abandoned: the capture was cancelled")
                    return nil
                }
                total += Int64(data.count)
                if total > ceiling {
                    try? output.close()
                    try? FileManager.default.removeItem(at: target)
                    log.warning("file \(index) refused: over its ceiling of \(ceiling / 1024 / 1024) MB")
                    return nil
                }
                try output.write(contentsOf: data)
            }
            log.debug("file \(index) copied: \(mime, privacy: .public), \(total) bytes")
            return (["path": target.path, "name": name, "mime": mime, "size": total], total)
        } catch {
            try? FileManager.default.removeItem(at: target)
            log.warning("file \(index) refused: \(error.localizedDescription)")
            return nil
        }
    }

    /// The texts of a share, one per line, a part another one already carries left out - a browser
    /// shares a title and a link that may repeat it.
    private func joinTexts(_ parts: [String]) -> String {
        var kept: [String] = []
        for part in parts where !part.isEmpty && !kept.contains(where: { $0.contains(part) }) {
            kept.append(part)
        }
        return kept.joined(separator: "\n")
    }

    /// A share that kept nothing still has refusals the member must hear about: added to the share
    /// still waiting when both come from the SAME session, or handed over alone. Never across a
    /// sign-out (Android's `reportRefusals`).
    private func reportRefusals(_ container: URL, refused: Int, epoch: Int64) -> Bool {
        let waiting = claimPending(container)
        let waitingEpoch = waiting.map { epochOf($0) } ?? epoch
        if let newer = waiting, waitingEpoch > epoch {
            _ = writePending(container, newer)
            log.warning("\(refused) refusal(s) from a signed-out session (epoch \(epoch)) dropped")
            return false
        }
        if let stale = waiting, waitingEpoch < epoch, let staleId = stale["id"] as? String,
           ShareCapture.isSafeId(staleId) {
            let inbox = container.appendingPathComponent(ShareCapture.inboxDir, isDirectory: true)
            deleteDir(inbox.appendingPathComponent(staleId, isDirectory: true), why: "stale share (epoch \(waitingEpoch))")
        }
        var payload: [String: Any]
        if var same = waiting, waitingEpoch == epoch {
            same["refused"] = ((same["refused"] as? NSNumber)?.intValue ?? 0) + refused
            payload = same
        } else {
            payload = ["id": UUID().uuidString, "epoch": epoch, "text": "", "files": [Any](), "refused": refused]
        }
        log.warning("a share kept nothing: \(refused) refusal(s) reported")
        return writePending(container, payload)
    }

    /// The share epoch the app's sign-outs advance (the App Group copy, written whole by a rename); 0
    /// before the first sign-out. Unreadable is read as 0, which is STALE once any sign-out happened -
    /// said at the level that accuses.
    private func readEpoch(_ container: URL) -> Int64 {
        let file = container.appendingPathComponent(ShareCapture.epochFile)
        guard FileManager.default.fileExists(atPath: file.path) else { return 0 }
        guard let raw = try? String(contentsOf: file, encoding: .utf8),
              let value = Int64(raw.trimmingCharacters(in: .whitespacesAndNewlines))
        else {
            log.error("the share epoch is unreadable - this share is stamped 0, which is stale")
            return 0
        }
        return value
    }

    private func epochOf(_ manifest: [String: Any]) -> Int64 {
        return (manifest["epoch"] as? NSNumber)?.int64Value ?? 0
    }

    /// Takes the manifest still waiting in the App Group, if any: renamed out of the way first, then
    /// read and deleted. Nil when none waits, or it was unreadable (said).
    private func claimPending(_ container: URL) -> [String: Any]? {
        let pending = container.appendingPathComponent(ShareCapture.pendingFile).path
        let claimed = container.appendingPathComponent(ShareCapture.pendingFile + ".replacing")
        guard rename(pending, claimed.path) == 0 else { return nil }
        defer {
            do {
                try FileManager.default.removeItem(at: claimed)
            } catch {
                log.warning("the claimed manifest was not deleted: \(error.localizedDescription)")
            }
        }
        guard let data = try? Data(contentsOf: claimed),
              let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
        else {
            log.warning("the waiting share manifest is unreadable")
            return nil
        }
        return object
    }

    /// WRITTEN WHOLE OR NOT AT ALL: the app may import at any moment, and a rename within one
    /// directory is atomic and replaces the manifest it lands on.
    private func writePending(_ container: URL, _ payload: [String: Any]) -> Bool {
        let target = container.appendingPathComponent(ShareCapture.pendingFile).path
        let staging = container.appendingPathComponent(ShareCapture.pendingFile + ".tmp")
        do {
            let data = try JSONSerialization.data(withJSONObject: payload)
            try data.write(to: staging)
        } catch {
            log.error("the share manifest could not be written: \(error.localizedDescription)")
            return false
        }
        if rename(staging.path, target) == 0 {
            // Per file and after every write: the rename is a new inode, which does not carry the
            // flag. The manifest holds the shared text, and the App Group is backed up.
            excludeFromBackup(URL(fileURLWithPath: target))
            return true
        }
        log.error("the share manifest could not be renamed into place: errno \(errno)")
        try? FileManager.default.removeItem(at: staging)
        return false
    }

    private func deleteDir(_ dir: URL, why: String) {
        do {
            try FileManager.default.removeItem(at: dir)
            log.debug("\(why, privacy: .public): share directory deleted")
        } catch {
            log.warning("\(why, privacy: .public): share directory not deleted: \(error.localizedDescription)")
        }
    }

    /// Keeps a share file or the inbox out of iCloud and computer backups - the NSE's
    /// `excludeFromBackup`, the same three calls. Never the App Group container itself, which holds
    /// what a restore must bring back. A failure is said with its error's domain and code, never its
    /// text, and changes nothing else.
    private func excludeFromBackup(_ url: URL) {
        var target = url
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        do {
            try target.setResourceValues(values)
        } catch {
            let failure = error as NSError
            log.error("\(url.lastPathComponent, privacy: .public) not excluded from backups: \(failure.domain, privacy: .public) \(failure.code)")
        }
    }

    /// Tells a RUNNING app that a share waits (it imports at its next activation otherwise).
    private func postReady() {
        CFNotificationCenterPostNotification(
            CFNotificationCenterGetDarwinNotifyCenter(),
            CFNotificationName(ShareCapture.readyNotification as CFString),
            nil, nil, true)
    }
}
