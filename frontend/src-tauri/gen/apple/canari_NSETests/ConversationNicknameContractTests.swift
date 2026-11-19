// The iOS extension's half of the notification-nickname rule (owner, 2026-11-14: "comme sur
// Messenger, tous les pseudos"); Android's is `ConversationNicknamesTest` in `src-tauri/android-tests`,
// which runs in CI, and the client's and Rust's run there too.
//
// NOT YET COMPILED, AND NOT WIRED TO A TARGET, for the reason `MentionDecisionContractTests` gives.

import XCTest

final class ConversationNicknameContractTests: XCTestCase {
  private func contract() throws -> [String: Any] {
    let url = URL(fileURLWithPath: #filePath)
      .deletingLastPathComponent()
      .appendingPathComponent("../../../../../libs/contracts/notification-nickname.cases.json")
    let data = try Data(contentsOf: url)
    return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
  }

  func testFollowsTheSharedNotificationNicknameContract() throws {
    let root = try contract()
    let raw = try XCTUnwrap(root["book"] as? [String: Any])
    var scopes: [String: [String: String]] = [:]
    for (scope, members) in (raw["scopes"] as? [String: Any]) ?? [:] {
      scopes[scope] = ((members as? [String: Any]) ?? [:]).compactMapValues { $0 as? String }
    }
    let book = NotificationService.NicknameBook(
      owner: ((raw["userId"] as? String) ?? "").lowercased(), scopes: scopes,
      channels: ((raw["channels"] as? [String: Any]) ?? [:]).compactMapValues { $0 as? String })
    let cases = try XCTUnwrap(root["cases"] as? [[String: Any]])
    XCTAssertGreaterThan(cases.count, 10)
    for c in cases {
      let got = NotificationService.conversationNickname(
        book: book, me: c["me"] as? String, salon: (c["kind"] as? String) == "salon",
        conversation: c["conversation"] as? String ?? "", memberId: c["member"] as? String ?? "")
      XCTAssertEqual(got, c["expected"] as? String, c["name"] as? String ?? "")
    }
  }

  func testAProvenSalonAuthorIsNamedByTheirNicknameAndAnUnprovenOneIsNot() {
    let alice = String(repeating: "a", count: 64)
    let book = { (names: [alice: "Alice Martin"] as [String: Any]?, unusable: nil as String?) }
    XCTAssertEqual(
      NotificationService.channelBannerAuthor(
        showsMessage: true, authorProven: true, authorId: alice, nickname: { _ in "La Prez" },
        book: book),
      .named(id: alice, name: "La Prez"))
    XCTAssertEqual(
      NotificationService.channelBannerAuthor(
        showsMessage: true, authorProven: false, authorId: alice, nickname: { _ in "La Prez" },
        book: book),
      .unnamed(id: alice, reason: "v1-session"))
  }
}
