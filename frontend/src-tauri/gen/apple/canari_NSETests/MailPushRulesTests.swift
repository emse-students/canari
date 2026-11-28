// The iOS extension's rules for the new mail behind an empty push (mail lot 5). The cursor format and
// the Keychain names are held together with the page and Rust by `mailPushSecret.test.ts`, which runs.
//
// NOT YET COMPILED, AND NOT WIRED TO A TARGET, for the reason `MentionDecisionContractTests` gives.

import XCTest

final class MailPushRulesTests: XCTestCase {
  private func item(_ id: Int, unread: Bool) -> MailPushItem {
    MailPushItem(id: id, unread: unread, sender: "S\(id)", subject: "s\(id)")
  }

  func testNoCursorTakesABaselineAndShowsTheNewestUnread() {
    let items = [item(9, unread: false), item(8, unread: true), item(7, unread: true)]
    let (highest, fresh) = MailPushRules.decide(items: items, cursor: nil)
    XCTAssertEqual(highest, 9)
    XCTAssertEqual(fresh.map(\.id), [8])
  }

  func testACursorShowsOnlyTheUnreadAboveIt() {
    let items = [item(12, unread: true), item(11, unread: false), item(10, unread: true), item(9, unread: true)]
    let (highest, fresh) = MailPushRules.decide(items: items, cursor: 10)
    XCTAssertEqual(highest, 12)
    XCTAssertEqual(fresh.map(\.id), [12])
  }

  func testNothingAboveKeepsTheCursor() {
    let (highest, fresh) = MailPushRules.decide(items: [item(5, unread: true)], cursor: 7)
    XCTAssertEqual(highest, 7)
    XCTAssertTrue(fresh.isEmpty)
  }

  func testTheCursorIsTheAccountsOnly() throws {
    let data = MailPushRules.cursorJson(account: "A@B.fr", highest: 4)
    XCTAssertEqual(MailPushRules.parseCursor(data, account: "a@b.fr"), 4)
    XCTAssertNil(MailPushRules.parseCursor(data, account: "c@b.fr"))
  }

  func testTheSecretNeedsEveryField() {
    XCTAssertNotNil(MailPushRules.parseSecret(Data(#"{"userId":"u","account":"A@b","password":"p"}"#.utf8)))
    XCTAssertNil(MailPushRules.parseSecret(Data(#"{"userId":"u","account":"a@b"}"#.utf8)))
  }

  func testItemsSkipASharedIdAndReadTheSender() {
    let body: [String: Any] = [
      "SearchResponse": [
        "m": [
          ["id": "3", "f": "u", "su": "Hi", "e": [["t": "f", "a": "x@y", "p": "X"]]],
          ["id": "acc:4", "f": "u"],
        ]
      ]
    ]
    let items = MailPushRules.parseItems(body)
    XCTAssertEqual(items.map(\.id), [3])
    XCTAssertEqual(items.first?.sender, "X")
    XCTAssertEqual(items.first?.unread, true)
  }
}
