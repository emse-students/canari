// The iOS extension's half of the shared mention-decision contract
// (`libs/contracts/mention-decision.cases.json`), also read by the client's
// `conversationLevel.contract.test.ts` and Android's `NotificationLevelGateTest`.
//
// NOT YET COMPILED, AND NOT WIRED TO A TARGET: the workstation that wrote it has no Xcode, and
// the Xcode project declares no test bundle for the extension. Wiring it means adding a unit-test
// target whose sources are this directory plus `canari_NSE/NotificationService.swift`, with
// `CANARI_REPO_ROOT` set in the scheme's test environment.

import XCTest

final class MentionDecisionContractTests: XCTestCase {
  private struct Contract: Decodable {
    struct Case: Decodable {
      let name: String
      let level: String?
      let text: String?
      let me: String?
      let expected: String
    }
    let me: String
    let cases: [Case]
  }

  func testFollowsTheSharedContract() throws {
    let root = ProcessInfo.processInfo.environment["CANARI_REPO_ROOT"] ?? ""
    let url = URL(fileURLWithPath: root)
      .appendingPathComponent("libs/contracts/mention-decision.cases.json")
    let contract = try JSONDecoder().decode(Contract.self, from: Data(contentsOf: url))
    var checked = 0
    // A visible frame never carries `none` (the server sends it silent): those cases are the client's.
    for c in contract.cases where c.level != "none" {
      let me = c.me.map { $0 == "self" ? contract.me : $0 }
      let decision = NotificationService.levelDecision(
        level: c.level, mentioned: c.text.map { NotificationService.mentionedUserIds(in: $0) },
        myUserId: me, groupId: "contract")
      let got = decision.quiet ? "withhold" : (decision.mentionsMe ? "alert-mention" : "alert")
      XCTAssertEqual(got, c.expected, c.name)
      checked += 1
    }
    XCTAssertGreaterThan(checked, 0)
  }
}
