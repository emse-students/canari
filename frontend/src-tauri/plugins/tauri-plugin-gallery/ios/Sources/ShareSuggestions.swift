import Foundation
import Intents

/// Canari's recent conversations as SUGGESTIONS in the iPhone share sheet (sharing lot S5, the iOS
/// twin of Android's `ShareTargets.kt`): one donated `INSendMessageIntent` per conversation, whose
/// `conversationIdentifier` the Share Extension reads back when the member picks it
/// (`ShareViewController`, `ShareRules.suggestedTarget`) and carries into the handoff manifest as
/// `target` - the same hint Android's `EXTRA_SHORTCUT_ID` gives. The page checks it against the
/// signed-in account (`suggestionIfHeld`) and the picker still opens: a suggestion is a
/// preselection, never a destination by itself.
///
/// WHAT IS DONATED. The page's own list (the picker's destinations, most recent first,
/// `MAX_SHARE_TARGETS`), one interaction each: an OUTGOING `INSendMessageIntent` with the
/// conversation id and its name as `speakableGroupName`, no recipients and no image (Apple's own
/// example donates a group name alone; the avatar is not reachable here, as on Android).
///
/// WHAT IS REMOVED, AND HOW IT IS KNOWN. Every interaction carries [groupIdentifier], a name this
/// app alone writes, and a publish or a clear deletes that GROUP - so exactly what this object
/// donated goes, whatever process donated it, and nothing else the system learned about the app.
/// A publish deletes first and donates only once the delete succeeded: a failed delete donates
/// nothing and fails the call, or the old account's suggestions would stay beside the new ones.
///
/// The platform neither lists nor counts donations, so `present` is the number of donations it
/// accepted, and a clear answers how many the last publish left (`UserDefaults`, [countKey]).
///
/// ONE serial queue: a clear issued at sign-out after a publish is applied after it.
enum ShareSuggestions {
  /// The donation group. Written by nothing else; `iosShareExtension.test.ts` pins it.
  static let groupIdentifier = "fr.emse.canari.share-suggestions"

  /// The page's ids are `c:<conversation id>` (`shareTargetsNative.ts`), as on Android.
  static let idPrefix = "c:"
  static let maxIdLength = 200
  static let maxLabelLength = 100

  /// How many interactions the last publish donated - the number a clear reports.
  private static let countKey = "fr.emse.canari.shareSuggestions.donated"

  private static let queue = DispatchQueue(label: "fr.emse.canari.share-suggestions")

  /// One target as the page sends it (`ShareTarget` in `commands.rs`). `link` is Android's
  /// launcher deep link and has no use here.
  struct Target {
    let id: String
    let label: String
  }

  /// What the call answers to the page; `leftover` is always 0 on iOS, since a failed delete fails
  /// the whole call instead.
  struct Published {
    let present: Int
    let leftover: Int
  }

  enum Failure: Error {
    /// The previous donations could not be deleted (the `NSError` code of the platform).
    case deleteFailed(Int)
  }

  static func isValid(_ target: Target) -> Bool {
    return target.id.hasPrefix(idPrefix)
      && (idPrefix.count + 1...maxIdLength).contains(target.id.count)
      && !target.label.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
      && target.label.count <= maxLabelLength
  }

  /// Replaces the donated suggestions with `targets` (most recent first) and calls `done` on the
  /// suggestions queue.
  static func publish(_ targets: [Target], done: @escaping (Result<Published, Failure>) -> Void) {
    queue.async {
      var seen = Set<String>()
      let valid = targets.filter { isValid($0) && seen.insert($0.id).inserted }
      if valid.count < targets.count {
        NSLog("[ShareSuggestions] publish: %d malformed target(s) dropped", targets.count - valid.count)
      }
      if let code = deleteGroup() {
        NSLog("[ShareSuggestions] publish: the previous suggestions were not deleted (code %d) - nothing donated", code)
        done(.failure(.deleteFailed(code)))
        return
      }
      UserDefaults.standard.set(0, forKey: countKey)
      // The MOST RECENT LAST: the system weighs recent donations, so the list is donated oldest
      // first. Each in its own completion: one refused must not take the others with it.
      var present = 0
      for (rank, target) in valid.enumerated().reversed() {
        if let code = donate(target) {
          NSLog("[ShareSuggestions] publish: target #%d was not donated (code %d)", rank, code)
        } else {
          present += 1
        }
      }
      UserDefaults.standard.set(present, forKey: countKey)
      NSLog("[ShareSuggestions] publish: %d of %d donated", present, valid.count)
      done(.success(Published(present: present, leftover: 0)))
    }
  }

  /// Deletes every suggestion this app donated; answers how many the last publish left.
  static func clear(done: @escaping (Result<Int, Failure>) -> Void) {
    queue.async {
      let held = UserDefaults.standard.integer(forKey: countKey)
      if let code = deleteGroup() {
        NSLog("[ShareSuggestions] clear: the suggestions were not deleted (code %d)", code)
        done(.failure(.deleteFailed(code)))
        return
      }
      UserDefaults.standard.set(0, forKey: countKey)
      NSLog("[ShareSuggestions] clear: %d suggestion(s) deleted", held)
      done(.success(held))
    }
  }

  /// Deletes the donation group, waiting for the platform's answer (this runs on [queue], never
  /// the main thread). Returns the error code, or nil on success.
  private static func deleteGroup() -> Int? {
    let finished = DispatchSemaphore(value: 0)
    var failure: Int?
    INInteraction.delete(with: groupIdentifier) { error in
      if let error = error {
        failure = (error as NSError).code
      }
      finished.signal()
    }
    finished.wait()
    return failure
  }

  /// Donates one conversation, waiting for the platform's answer. Returns the error code, or nil.
  private static func donate(_ target: Target) -> Int? {
    let intent = INSendMessageIntent(
      recipients: nil,
      outgoingMessageType: .outgoingMessageText,
      content: nil,
      speakableGroupName: INSpeakableString(spokenPhrase: target.label),
      conversationIdentifier: target.id,
      serviceName: nil,
      sender: nil,
      attachments: nil)
    let interaction = INInteraction(intent: intent, response: nil)
    interaction.direction = .outgoing
    interaction.identifier = target.id
    interaction.groupIdentifier = groupIdentifier
    let finished = DispatchSemaphore(value: 0)
    var failure: Int?
    interaction.donate { error in
      if let error = error {
        failure = (error as NSError).code
      }
      finished.signal()
    }
    finished.wait()
    return failure
  }
}
