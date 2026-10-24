// The iOS extension's half of the salon banner attribution rule; Android's is
// `ChannelBannerAttributionTest` in `src-tauri/android-tests`, which runs in CI.
//
// NOT YET COMPILED, AND NOT WIRED TO A TARGET, for the reason `MentionDecisionContractTests` gives.

import XCTest

final class ChannelBannerAttributionTests: XCTestCase {
  func testABlindBannerNamesNoAuthorAndNoMention() {
    let a = NotificationService.channelBannerAttribution(
      showsMessage: false, senderId: "alice", serverSaysMentioned: true)
    XCTAssertNil(a.authorId)
    XCTAssertFalse(a.mentionsMe)
  }

  func testAnOpenedBannerDrawsTheAuthorAndTheMention() {
    let a = NotificationService.channelBannerAttribution(
      showsMessage: true, senderId: "alice", serverSaysMentioned: true)
    XCTAssertEqual(a.authorId, "alice")
    XCTAssertTrue(a.mentionsMe)
  }

  func testAnOpenedBannerWithoutASenderDrawsTheSalonInitials() {
    let a = NotificationService.channelBannerAttribution(
      showsMessage: true, senderId: "", serverSaysMentioned: false)
    XCTAssertNil(a.authorId)
  }
}
