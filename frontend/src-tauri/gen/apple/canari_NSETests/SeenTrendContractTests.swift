// The iOS extension's half of the seen-trend rule (owner, 2026-11-24, "Verif sur l'appareil": a
// campus trend for a post this device already displayed shows nothing); Android's is `SeenTrendsTest`
// in `src-tauri/android-tests`, which runs in CI, and the client's and Rust's run there too.
//
// NOT YET COMPILED, AND NOT WIRED TO A TARGET, for the reason `MentionDecisionContractTests` gives.

import XCTest

final class SeenTrendContractTests: XCTestCase {
  func testFollowsTheSharedNotificationSeenTrendContract() throws {
    let url = URL(fileURLWithPath: #filePath)
      .deletingLastPathComponent()
      .appendingPathComponent("../../../../../libs/contracts/notification-seen-trend.cases.json")
    let root = try XCTUnwrap(
      JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
    let raw = try XCTUnwrap(root["book"] as? [String: Any])
    let book = NotificationService.SeenPostsBook(
      owner: ((raw["userId"] as? String) ?? "").lowercased(),
      posts: Set(((raw["posts"] as? [String: Any]) ?? [:]).keys.map { $0.lowercased() }))
    XCTAssertEqual(
      Set((root["trendKeys"] as? [String]) ?? []), NotificationService.trendContentKeys)
    let cases = try XCTUnwrap(root["cases"] as? [[String: Any]])
    XCTAssertGreaterThan(cases.count, 10)
    for c in cases {
      let got = NotificationService.seenTrendWithheld(
        book: book, me: c["me"] as? String, contentKey: c["contentKey"] as? String,
        postId: c["postId"] as? String)
      XCTAssertEqual(got, c["expected"] as? Bool, c["name"] as? String ?? "")
    }
  }
}
