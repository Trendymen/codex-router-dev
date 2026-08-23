import Foundation
import Testing

@testable import ModelRouterTray

// The status panel uses one concise caption for every quota-reset row. The
// injected clock keeps the boundary deterministic while the Tray language
// suite mutates the process-wide selection from a parallel suite.
@Suite("Quota reset labels", .serialized)
struct QuotaResetLabelTests {
  let now = Date(timeIntervalSince1970: 1_770_000_000)

  @Test("past reset uses the localized soon label")
  func pastReset() {
    let original = RouterLanguage.selection
    defer { RouterLanguage.setSelection(original) }

    for language in [TrayLanguage.english, .chinese] {
      RouterLanguage.setSelection(language)
      #expect(
        usageResetCaption(now.addingTimeInterval(-5), now: now) == routerLocalized("resets soon")
      )
    }
  }

  @Test("future reset uses abbreviated date and shortened time")
  func futureReset() {
    let reset = now.addingTimeInterval(45 * 60)
    #expect(
      usageResetCaption(reset, now: now) == reset.formatted(date: .abbreviated, time: .shortened)
    )
  }
}
