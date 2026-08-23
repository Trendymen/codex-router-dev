import Foundation
import Testing

@testable import ModelRouterTray

// The status panel uses one concise caption for every quota-reset row. The
// injected clock and localization closure keep these tests deterministic and
// independent of process-wide Tray settings.
@Suite("Quota reset labels")
struct QuotaResetLabelTests {
  let now = Date(timeIntervalSince1970: 1_770_000_000)

  @Test("past reset uses the caller's localized soon label")
  func pastReset() {
    let english = usageResetCaption(
      now.addingTimeInterval(-5),
      now: now,
      localize: { _ in "resets soon" }
    )
    let chinese = usageResetCaption(
      now.addingTimeInterval(-5),
      now: now,
      localize: { _ in "即将重置" }
    )
    #expect(english == "resets soon")
    #expect(chinese == "即将重置")
  }

  @Test("future reset uses abbreviated date and shortened time")
  func futureReset() {
    let reset = now.addingTimeInterval(45 * 60)
    #expect(
      usageResetCaption(reset, now: now, localize: { _ in "ignored" })
        == reset.formatted(date: .abbreviated, time: .shortened)
    )
  }
}
