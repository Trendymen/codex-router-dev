import AppKit
import Combine
import Foundation
import SwiftUI
import UniformTypeIdentifiers

// The tray keeps a quiet, single-accent surface. The Dynamic Island consumes
// these same colors from IslandOverlay.swift, so the two presentations do not
// drift into competing visual systems.
let routerAccent = Color(red: 0.12, green: 0.40, blue: 0.76)
let routerMint = Color(red: 0.04, green: 0.52, blue: 0.31)
let routerYellow = Color(red: 0.68, green: 0.40, blue: 0.03)
let routerRed = Color(red: 0.72, green: 0.16, blue: 0.12)
let routerInk = Color(red: 0.035, green: 0.043, blue: 0.055)
let routerText = Color.primary.opacity(0.92)
let routerMuted = Color.primary.opacity(0.76)
let routerMutedStrong = Color.primary.opacity(0.90)

enum RouterActivityState: String, Decodable {
  case idle
  case generating
  case starting
  case error

  var tint: Color {
    switch self {
    case .idle: return routerMint
    case .generating: return routerYellow
    case .starting: return routerAccent
    case .error: return routerRed
    }
  }

  var label: String {
    switch self {
    case .idle: return routerLocalized("Idle")
    case .generating: return routerLocalized("Thinking")
    case .starting: return routerLocalized("Starting")
    case .error: return routerLocalized("Error")
    }
  }
}

struct RouterActiveRequest: Decodable, Identifiable, Equatable {
  let id: String
  let provider: String
  let model: String?
  let sessionName: String?
  let sessionId: String?
  let threadId: String?
  let parentThreadId: String?
  let agentName: String?
  let agentNickname: String?
  let isSubagent: Bool?
  let startedAt: Double

  init(from decoder: Decoder) throws {
    let values = try decoder.container(keyedBy: CodingKeys.self)
    id = try values.decodeIfPresent(String.self, forKey: .id) ?? UUID().uuidString
    provider = try values.decodeIfPresent(String.self, forKey: .provider) ?? "openai"
    model = try values.decodeIfPresent(String.self, forKey: .model)
    sessionName = try values.decodeIfPresent(String.self, forKey: .sessionName)
    sessionId = try values.decodeIfPresent(String.self, forKey: .sessionId)
    threadId = try values.decodeIfPresent(String.self, forKey: .threadId)
    parentThreadId = try values.decodeIfPresent(String.self, forKey: .parentThreadId)
    agentName = try values.decodeIfPresent(String.self, forKey: .agentName)
    agentNickname = try values.decodeIfPresent(String.self, forKey: .agentNickname)
    isSubagent = try values.decodeIfPresent(Bool.self, forKey: .isSubagent)
    startedAt = try values.decodeIfPresent(Double.self, forKey: .startedAt) ?? 0
  }

  private enum CodingKeys: String, CodingKey {
    case id, provider, model, sessionName, sessionId, threadId, parentThreadId
    case agentName, agentNickname, isSubagent, startedAt
  }
}

// MARK: - Versioned Node capability contract

enum CapabilityCommandCatalog {
  // This is deliberately checked against test/fixtures/required-capabilities.json.
  // The fixture is independent; this list makes the native source auditable and
  // prevents an accidental return to ad-hoc legacy command aliases.
  static let canonicalCommandIDs: [String] = [
    "lifecycle.status", "lifecycle.start", "lifecycle.stop", "lifecycle.restart", "lifecycle.logs",
    "doctor.status", "doctor.fix", "maintenance.update", "maintenance.rollback",
    "native.status", "native.account-usage",
    "credential.status", "credential.set", "credential.remove",
    "provider.enable", "model.visibility", "model.canary",
    "protocol-proof.status", "protocol-proof.verify", "protocol-proof.revoke",
    "picker.status", "picker.set", "picker.show-all", "catalog.status", "catalog.render-snippet",
    "subagents.status", "subagents.mode", "subagents.model", "subagents.selection", "subagents.verify",
    "failover.status", "failover.reset",
    "tool-result-aging.status", "tool-result-aging.on", "tool-result-aging.off", "tool-result-aging.ttl", "tool-result-aging.purge",
    "usage.router", "usage.provider", "usage.model",
    "vision.status", "vision.on", "vision.off", "vision.engine", "vision.effort", "vision.probe", "vision.pull", "vision.purge-cache",
    "presence.status", "presence.mode",
    "cc-switch.status", "cc-switch.snippet"
  ]

  static let canonicalCommandSet = Set(canonicalCommandIDs)
}

struct CapabilityArgumentDefinition: Decodable {
  let type: String
  let required: Bool
  let enumValues: [String]

  init(from decoder: Decoder) throws {
    let values = try decoder.container(keyedBy: CodingKeys.self)
    if let single = try? values.decode(String.self, forKey: .type) {
      type = single
    } else {
      type = (try values.decodeIfPresent([String].self, forKey: .type) ?? []).joined(separator: "|")
    }
    required = try values.decodeIfPresent(Bool.self, forKey: .required) ?? false
    enumValues = try values.decodeIfPresent([String].self, forKey: .enumValues) ?? []
  }

  private enum CodingKeys: String, CodingKey { case type, required, enumValues = "enum" }
}

struct CapabilityArgumentSchema: Decodable {
  let properties: [String: CapabilityArgumentDefinition]

  init(from decoder: Decoder) throws {
    let values = try decoder.container(keyedBy: CodingKeys.self)
    properties = try values.decodeIfPresent([String: CapabilityArgumentDefinition].self, forKey: .properties) ?? [:]
  }

  init(properties: [String: CapabilityArgumentDefinition] = [:]) {
    self.properties = properties
  }

  private enum CodingKeys: String, CodingKey { case properties }
}

struct CapabilityCommand: Decodable, Identifiable {
  let name: String
  let arguments: CapabilityArgumentSchema
  let isMutating: Bool
  let confirmation: String
  let quotaWarning: String
  let protectedInput: Bool
  let resultKind: String

  var id: String { name }
  var requiresConfirmation: Bool { confirmation != "none" }
  var hasQuotaWarning: Bool { quotaWarning != "none" }

  init(from decoder: Decoder) throws {
    let values = try decoder.container(keyedBy: CodingKeys.self)
    name = try values.decode(String.self, forKey: .name)
    arguments = try values.decodeIfPresent(CapabilityArgumentSchema.self, forKey: .arguments) ?? CapabilityArgumentSchema()
    isMutating = try values.decodeIfPresent(Bool.self, forKey: .mutationFlag) ?? false
    confirmation = try values.decodeIfPresent(String.self, forKey: .confirmation) ?? "none"
    quotaWarning = try values.decodeIfPresent(String.self, forKey: .quotaWarning) ?? "none"
    protectedInput = try values.decodeIfPresent(Bool.self, forKey: .protectedInput) ?? false
    resultKind = try values.decodeIfPresent(String.self, forKey: .resultKind) ?? "json"
  }

  private enum CodingKeys: String, CodingKey {
    case name, arguments, mutationFlag = "mutating", confirmation, quotaWarning, protectedInput, resultKind
  }
}

struct CapabilityDescription: Decodable, Identifiable {
  let id: String
  let schemaVersion: Int
  let nodeCommands: [String]
  let swift: String
  let browser: String
  let confirmation: [String]
  let quotaWarning: [String]
  let protectedInput: [String]
  let resultKind: [String: String]

  init(from decoder: Decoder) throws {
    let values = try decoder.container(keyedBy: CodingKeys.self)
    id = try values.decode(String.self, forKey: .id)
    schemaVersion = try values.decodeIfPresent(Int.self, forKey: .schemaVersion) ?? 1
    nodeCommands = try values.decodeIfPresent([String].self, forKey: .nodeCommands) ?? []
    swift = try values.decodeIfPresent(String.self, forKey: .swift) ?? "read-only"
    browser = try values.decodeIfPresent(String.self, forKey: .browser) ?? "full"
    confirmation = try values.decodeIfPresent([String].self, forKey: .confirmation) ?? []
    quotaWarning = try values.decodeIfPresent([String].self, forKey: .quotaWarning) ?? []
    protectedInput = try values.decodeIfPresent([String].self, forKey: .protectedInput) ?? []
    resultKind = try values.decodeIfPresent([String: String].self, forKey: .resultKind) ?? [:]
  }

  private enum CodingKeys: String, CodingKey {
    case id, schemaVersion, nodeCommands, swift, browser, confirmation, quotaWarning, protectedInput, resultKind
  }
}

struct CapabilityCompatibility: Decodable {
  let readOnly: Bool
  let reason: String?

  init(from decoder: Decoder) throws {
    let values = try decoder.container(keyedBy: CodingKeys.self)
    readOnly = try values.decodeIfPresent(Bool.self, forKey: .readOnly) ?? false
    reason = try values.decodeIfPresent(String.self, forKey: .reason)
  }

  init(readOnly: Bool, reason: String?) {
    self.readOnly = readOnly
    self.reason = reason
  }

  private enum CodingKeys: String, CodingKey { case readOnly, reason }
}

struct CapabilitySnapshotV1: Decodable {
  let capabilitySchemaVersion: Int
  let compatibility: CapabilityCompatibility
  let mutationsEnabled: Bool
  let commands: [CapabilityCommand]
  let capabilities: [CapabilityDescription]

  static let empty = CapabilitySnapshotV1(
    capabilitySchemaVersion: 1,
    compatibility: CapabilityCompatibility(readOnly: true, reason: "not_loaded"),
    mutationsEnabled: false,
    commands: [],
    capabilities: []
  )

  init(
    capabilitySchemaVersion: Int,
    compatibility: CapabilityCompatibility,
    mutationsEnabled: Bool,
    commands: [CapabilityCommand],
    capabilities: [CapabilityDescription]
  ) {
    self.capabilitySchemaVersion = capabilitySchemaVersion
    self.compatibility = compatibility
    self.mutationsEnabled = mutationsEnabled
    self.commands = commands
    self.capabilities = capabilities
  }

  init(from decoder: Decoder) throws {
    let values = try decoder.container(keyedBy: CodingKeys.self)
    capabilitySchemaVersion = try values.decodeIfPresent(Int.self, forKey: .capabilitySchemaVersion) ?? 0
    compatibility = try values.decodeIfPresent(CapabilityCompatibility.self, forKey: .compatibility)
      ?? CapabilityCompatibility(readOnly: capabilitySchemaVersion != 1, reason: capabilitySchemaVersion == 1 ? nil : "unknown_major_version")
    mutationsEnabled = try values.decodeIfPresent(Bool.self, forKey: .mutationsEnabled) ?? false
    commands = try values.decodeIfPresent([CapabilityCommand].self, forKey: .commands) ?? []
    capabilities = try values.decodeIfPresent([CapabilityDescription].self, forKey: .capabilities) ?? []
  }

  var isCompatible: Bool {
    capabilitySchemaVersion == 1 && !compatibility.readOnly && mutationsEnabled
  }

  var incompatibilityText: String {
    if compatibility.reason == "unknown_major_version" {
      return routerLocalized("Only health and version information is available for this Router capability version.")
    }
    return routerLocalized("Only health and version information is available until the Router capability snapshot is ready.")
  }

  func command(_ name: String) -> CapabilityCommand? {
    commands.first(where: { $0.name == name })
  }
}

// A small JSON value type keeps command results opaque to the tray while still
// allowing the status payload to be decoded into the presentation snapshot.
enum JSONValue: Codable, Equatable {
  case null
  case bool(Bool)
  case number(Double)
  case string(String)
  case array([JSONValue])
  case object([String: JSONValue])

  init(from decoder: Decoder) throws {
    let single = try decoder.singleValueContainer()
    if single.decodeNil() { self = .null; return }
    if let value = try? single.decode(Bool.self) { self = .bool(value); return }
    if let value = try? single.decode(Double.self) { self = .number(value); return }
    if let value = try? single.decode(String.self) { self = .string(value); return }
    if let value = try? single.decode([JSONValue].self) { self = .array(value); return }
    self = .object(try single.decode([String: JSONValue].self))
  }

  func encode(to encoder: Encoder) throws {
    var single = encoder.singleValueContainer()
    switch self {
    case .null: try single.encodeNil()
    case .bool(let value): try single.encode(value)
    case .number(let value): try single.encode(value)
    case .string(let value): try single.encode(value)
    case .array(let value): try single.encode(value)
    case .object(let value): try single.encode(value)
    }
  }
}

struct DesktopCommandError: Decodable, LocalizedError {
  let type: String
  let code: String
  let message: String
  let param: String?

  var errorDescription: String? { message }

  init(from decoder: Decoder) throws {
    let values = try decoder.container(keyedBy: CodingKeys.self)
    type = try values.decodeIfPresent(String.self, forKey: .type) ?? "router_error"
    code = try values.decodeIfPresent(String.self, forKey: .code) ?? "invalid_command_arguments"
    message = try values.decodeIfPresent(String.self, forKey: .message) ?? "The Router command failed."
    param = try values.decodeIfPresent(String.self, forKey: .param)
  }

  private enum CodingKeys: String, CodingKey { case type, code, message, param }
}

struct DesktopCommandEnvelope<Value: Decodable>: Decodable {
  let ok: Bool
  let value: Value?
  let error: DesktopCommandError?
}

private struct RouterError: LocalizedError {
  let message: String
  init(_ message: String) { self.message = message }
  var errorDescription: String? { message }
}

private struct DesktopCommandBridge {
  private let root: URL?

  init(root: URL? = nil) {
    self.root = root ?? Self.sealedSourceRoot()
  }

  private static func sealedSourceRoot() -> URL? {
    guard let value = Bundle.main.object(forInfoDictionaryKey: "ModelRouterSourceRoot") as? String else {
      return nil
    }
    let resolvedRoot = URL(fileURLWithPath: value).standardizedFileURL.resolvingSymlinksInPath()
    let control = resolvedRoot.appendingPathComponent("bin/control")
    guard FileManager.default.isExecutableFile(atPath: control.path) else { return nil }
    return resolvedRoot
  }

  func execute(
    _ command: String,
    arguments: [String: Any],
    protectedInput: String?
  ) async throws -> Data {
    guard let root else { throw RouterError("Cannot find the signed Router checkout.") }
    let bridge = root.appendingPathComponent("src/desktop-command-bridge.mjs")
    guard FileManager.default.fileExists(atPath: bridge.path) else {
      throw RouterError("The Router command bridge is unavailable.")
    }
    var request: [String: Any] = ["args": arguments]
    if let protectedInput { request["protectedInput"] = protectedInput }
    let input = try JSONSerialization.data(withJSONObject: request, options: [])

    return try await withCheckedThrowingContinuation { continuation in
      let process = Process()
      let stdin = Pipe()
      let stdout = Pipe()
      process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
      process.arguments = ["node", bridge.path, command]
      process.currentDirectoryURL = root
      process.standardInput = stdin
      process.standardOutput = stdout
      process.standardError = Pipe()
      process.terminationHandler = { process in
        let data = stdout.fileHandleForReading.readDataToEndOfFile()
        if process.terminationStatus == 0 {
          continuation.resume(returning: data)
        } else {
          continuation.resume(throwing: RouterError("The Router command failed."))
        }
      }
      do {
        try process.run()
        stdin.fileHandleForWriting.write(input)
        stdin.fileHandleForWriting.closeFile()
      } catch {
        continuation.resume(throwing: RouterError("The Router command could not start."))
      }
    }
  }
}

// MARK: - Router snapshot models consumed by the Dynamic Island

struct ProviderAccountMetric: Decodable, Equatable {
  let kind: String
  let label: String
  let usedPercent: Double?
  let remainingPercent: Double?
  let used: Double?
  let limit: Double?
  let remaining: Double?
  let unit: String?
  let resetAt: TimeInterval?
  let value: Double?
  let currency: String?
  let detail: String?
  let available: Bool?

  var resetDate: Date? { resetAt.map(Date.init(timeIntervalSince1970:)) }

  init(from decoder: Decoder) throws {
    let values = try decoder.container(keyedBy: CodingKeys.self)
    kind = try values.decodeIfPresent(String.self, forKey: .kind) ?? "quota"
    label = try values.decodeIfPresent(String.self, forKey: .label) ?? "Usage limit"
    usedPercent = try values.decodeIfPresent(Double.self, forKey: .usedPercent)
    remainingPercent = try values.decodeIfPresent(Double.self, forKey: .remainingPercent)
    used = try values.decodeIfPresent(Double.self, forKey: .used)
    limit = try values.decodeIfPresent(Double.self, forKey: .limit)
    remaining = try values.decodeIfPresent(Double.self, forKey: .remaining)
    unit = try values.decodeIfPresent(String.self, forKey: .unit)
    resetAt = try values.decodeIfPresent(TimeInterval.self, forKey: .resetAt)
    value = try values.decodeIfPresent(Double.self, forKey: .value)
    currency = try values.decodeIfPresent(String.self, forKey: .currency)
    detail = try values.decodeIfPresent(String.self, forKey: .detail)
    available = try values.decodeIfPresent(Bool.self, forKey: .available)
  }

  private enum CodingKeys: String, CodingKey {
    case kind, label, usedPercent, remainingPercent, used, limit, remaining, unit, resetAt, value, currency, detail, available
  }
}

struct ProviderAccountUsage: Decodable, Equatable {
  let status: String
  let source: String
  let metrics: [ProviderAccountMetric]
  let message: String?
  let plan: String?
  let dashboardUrl: String?

  init(from decoder: Decoder) throws {
    let values = try decoder.container(keyedBy: CodingKeys.self)
    status = try values.decodeIfPresent(String.self, forKey: .status) ?? "unknown"
    source = try values.decodeIfPresent(String.self, forKey: .source) ?? "router"
    metrics = try values.decodeIfPresent([ProviderAccountMetric].self, forKey: .metrics) ?? []
    message = try values.decodeIfPresent(String.self, forKey: .message)
    plan = try values.decodeIfPresent(String.self, forKey: .plan)
    dashboardUrl = try values.decodeIfPresent(String.self, forKey: .dashboardUrl)
  }

  private enum CodingKeys: String, CodingKey { case status, source, metrics, message, plan, dashboardUrl }
}

struct ProviderDailyUsageBucket: Decodable, Equatable {
  let startDate: String
  let tokens: Int64
  let requests: Int

  init(from decoder: Decoder) throws {
    let values = try decoder.container(keyedBy: CodingKeys.self)
    startDate = try values.decodeIfPresent(String.self, forKey: .startDate) ?? ""
    tokens = try values.decodeIfPresent(Int64.self, forKey: .tokens) ?? 0
    requests = try values.decodeIfPresent(Int.self, forKey: .requests) ?? 0
  }

  private enum CodingKeys: String, CodingKey { case startDate, tokens, requests }
}

struct RouterProviderUsage: Decodable, Identifiable, Equatable {
  let id: String
  let displayName: String
  let credentialType: String
  let scope: String
  let requests: Int
  let successfulRequests: Int
  let meteredRequests: Int
  let inputTokens: Int64
  let outputTokens: Int64
  let totalTokens: Int64
  let dailyUsageBuckets: [ProviderDailyUsageBucket]
  let account: ProviderAccountUsage

  init(from decoder: Decoder) throws {
    let values = try decoder.container(keyedBy: CodingKeys.self)
    id = try values.decodeIfPresent(String.self, forKey: .id) ?? "unknown"
    displayName = try values.decodeIfPresent(String.self, forKey: .displayName) ?? id
    credentialType = try values.decodeIfPresent(String.self, forKey: .credentialType) ?? "router"
    scope = try values.decodeIfPresent(String.self, forKey: .scope) ?? "router"
    requests = try values.decodeIfPresent(Int.self, forKey: .requests) ?? 0
    successfulRequests = try values.decodeIfPresent(Int.self, forKey: .successfulRequests) ?? 0
    meteredRequests = try values.decodeIfPresent(Int.self, forKey: .meteredRequests) ?? 0
    inputTokens = try values.decodeIfPresent(Int64.self, forKey: .inputTokens) ?? 0
    outputTokens = try values.decodeIfPresent(Int64.self, forKey: .outputTokens) ?? 0
    totalTokens = try values.decodeIfPresent(Int64.self, forKey: .totalTokens) ?? 0
    dailyUsageBuckets = try values.decodeIfPresent([ProviderDailyUsageBucket].self, forKey: .dailyUsageBuckets) ?? []
    account = try values.decodeIfPresent(ProviderAccountUsage.self, forKey: .account)
      ?? ProviderAccountUsage(status: "unknown", source: "router", metrics: [], message: nil, plan: nil, dashboardUrl: nil)
  }

  private enum CodingKeys: String, CodingKey {
    case id, displayName, credentialType, scope, requests, successfulRequests, meteredRequests
    case inputTokens, outputTokens, totalTokens, dailyUsageBuckets, account
  }
}

extension ProviderAccountUsage {
  init(status: String, source: String, metrics: [ProviderAccountMetric], message: String?, plan: String?, dashboardUrl: String?) {
    self.status = status
    self.source = source
    self.metrics = metrics
    self.message = message
    self.plan = plan
    self.dashboardUrl = dashboardUrl
  }
}

struct ProviderUsageSnapshot: Decodable, Equatable {
  let fetchedAt: String
  let scope: String
  let providers: [RouterProviderUsage]

  init(from decoder: Decoder) throws {
    let values = try decoder.container(keyedBy: CodingKeys.self)
    fetchedAt = try values.decodeIfPresent(String.self, forKey: .fetchedAt) ?? ""
    scope = try values.decodeIfPresent(String.self, forKey: .scope) ?? "router"
    providers = try values.decodeIfPresent([RouterProviderUsage].self, forKey: .providers) ?? []
  }

  private enum CodingKeys: String, CodingKey { case fetchedAt, scope, providers }
}

struct CodexRateLimitWindow: Decodable, Equatable {
  let usedPercent: Int
  let remainingPercent: Int
  let windowDurationMins: Int?
  let resetsAt: TimeInterval?

  var resetDate: Date? { resetsAt.map(Date.init(timeIntervalSince1970:)) }
  var durationLabel: String {
    guard let minutes = windowDurationMins else { return routerLocalized("Current limit") }
    if minutes >= 1_440, minutes.isMultiple(of: 1_440) {
      let days = minutes / 1_440
      if days == 1 { return routerLocalized("Daily limit") }
      if days == 7 { return routerLocalized("Weekly limit") }
      return "(days)-day limit"
    }
    return minutes >= 60 ? "(minutes / 60)-hour limit" : "(minutes)-minute limit"
  }

  init(from decoder: Decoder) throws {
    let values = try decoder.container(keyedBy: CodingKeys.self)
    usedPercent = try values.decodeIfPresent(Int.self, forKey: .usedPercent) ?? 0
    remainingPercent = try values.decodeIfPresent(Int.self, forKey: .remainingPercent) ?? 0
    windowDurationMins = try values.decodeIfPresent(Int.self, forKey: .windowDurationMins)
    resetsAt = try values.decodeIfPresent(TimeInterval.self, forKey: .resetsAt)
  }

  private enum CodingKeys: String, CodingKey { case usedPercent, remainingPercent, windowDurationMins, resetsAt }
}

struct CodexDailyUsageBucket: Decodable, Equatable {
  let startDate: String
  let tokens: Int64
  init(from decoder: Decoder) throws {
    let values = try decoder.container(keyedBy: CodingKeys.self)
    startDate = try values.decodeIfPresent(String.self, forKey: .startDate) ?? ""
    tokens = try values.decodeIfPresent(Int64.self, forKey: .tokens) ?? 0
  }
  private enum CodingKeys: String, CodingKey { case startDate, tokens }
}

struct CodexUsageSummary: Decodable, Equatable {
  let lifetimeTokens: Int64?
  let peakDailyTokens: Int64?
  let currentStreakDays: Int?
}

struct CodexAccountUsage: Decodable, Equatable {
  let fetchedAt: String
  let planType: String?
  let limitId: String?
  let primary: CodexRateLimitWindow?
  let secondary: CodexRateLimitWindow?
  let dailyUsageBuckets: [CodexDailyUsageBucket]
  let summary: CodexUsageSummary

  init(from decoder: Decoder) throws {
    let values = try decoder.container(keyedBy: CodingKeys.self)
    fetchedAt = try values.decodeIfPresent(String.self, forKey: .fetchedAt) ?? ""
    planType = try values.decodeIfPresent(String.self, forKey: .planType)
    limitId = try values.decodeIfPresent(String.self, forKey: .limitId)
    primary = try values.decodeIfPresent(CodexRateLimitWindow.self, forKey: .primary)
    secondary = try values.decodeIfPresent(CodexRateLimitWindow.self, forKey: .secondary)
    dailyUsageBuckets = try values.decodeIfPresent([CodexDailyUsageBucket].self, forKey: .dailyUsageBuckets) ?? []
    summary = try values.decodeIfPresent(CodexUsageSummary.self, forKey: .summary)
      ?? CodexUsageSummary(lifetimeTokens: nil, peakDailyTokens: nil, currentStreakDays: nil)
  }

  private enum CodingKeys: String, CodingKey {
    case fetchedAt, planType, limitId, primary, secondary, dailyUsageBuckets, summary
  }
}

struct RouterProviderInfo: Decodable {
  let id: String
  let displayName: String
  init(from decoder: Decoder) throws {
    let values = try decoder.container(keyedBy: CodingKeys.self)
    id = try values.decodeIfPresent(String.self, forKey: .id) ?? "unknown"
    displayName = try values.decodeIfPresent(String.self, forKey: .displayName) ?? id
  }
  private enum CodingKeys: String, CodingKey { case id, displayName }
}

struct RouterModel: Decodable, Identifiable {
  let slug: String
  let displayName: String
  let provider: String
  let enabled: Bool
  let visible: Bool?
  var id: String { slug }

  init(from decoder: Decoder) throws {
    let values = try decoder.container(keyedBy: CodingKeys.self)
    slug = try values.decodeIfPresent(String.self, forKey: .slug) ?? "unknown"
    displayName = try values.decodeIfPresent(String.self, forKey: .displayName) ?? slug
    provider = try values.decodeIfPresent(String.self, forKey: .provider) ?? "unknown"
    enabled = try values.decodeIfPresent(Bool.self, forKey: .enabled) ?? false
    visible = try values.decodeIfPresent(Bool.self, forKey: .visible)
  }
  private enum CodingKeys: String, CodingKey { case slug, displayName, provider, enabled, visible }
}

struct RouterTarget: Decodable {
  let target: String?
  let configured: Bool
  let active: Bool
  let enabledProviders: [String]
  let providers: [RouterProviderInfo]
  let models: [RouterModel]
  let selectedModel: String?

  init(from decoder: Decoder) throws {
    let values = try decoder.container(keyedBy: CodingKeys.self)
    target = try values.decodeIfPresent(String.self, forKey: .target)
    configured = try values.decodeIfPresent(Bool.self, forKey: .configured) ?? false
    active = try values.decodeIfPresent(Bool.self, forKey: .active) ?? false
    enabledProviders = try values.decodeIfPresent([String].self, forKey: .enabledProviders) ?? []
    providers = try values.decodeIfPresent([RouterProviderInfo].self, forKey: .providers) ?? []
    models = try values.decodeIfPresent([RouterModel].self, forKey: .models) ?? []
    selectedModel = try values.decodeIfPresent(String.self, forKey: .selectedModel)
  }

  private enum CodingKeys: String, CodingKey {
    case target, configured, active, enabledProviders, providers, models, selectedModel
  }
}

struct RouterPresence: Decodable {
  let mode: String
  let effectiveMode: String
  let harnessPublished: Bool
  let terminalCodex: Bool

  init(from decoder: Decoder) throws {
    let values = try decoder.container(keyedBy: CodingKeys.self)
    mode = try values.decodeIfPresent(String.self, forKey: .mode) ?? "always"
    effectiveMode = try values.decodeIfPresent(String.self, forKey: .effectiveMode) ?? mode
    harnessPublished = try values.decodeIfPresent(Bool.self, forKey: .harnessPublished) ?? false
    terminalCodex = try values.decodeIfPresent(Bool.self, forKey: .terminalCodex) ?? false
  }

  private enum CodingKeys: String, CodingKey { case mode, effectiveMode, harnessPublished, terminalCodex }
}

struct RouterSnapshot: Decodable {
  let targets: [String: RouterTarget]
  let presence: RouterPresence?
  let capabilities: CapabilitySnapshotV1?
  let accountUsage: CodexAccountUsage?
  let providerUsage: ProviderUsageSnapshot?

  static let empty = RouterSnapshot(targets: [:], presence: nil, capabilities: nil, accountUsage: nil, providerUsage: nil)

  init(targets: [String: RouterTarget], presence: RouterPresence?, capabilities: CapabilitySnapshotV1?, accountUsage: CodexAccountUsage?, providerUsage: ProviderUsageSnapshot?) {
    self.targets = targets
    self.presence = presence
    self.capabilities = capabilities
    self.accountUsage = accountUsage
    self.providerUsage = providerUsage
  }

  init(from decoder: Decoder) throws {
    let values = try decoder.container(keyedBy: CodingKeys.self)
    targets = try values.decodeIfPresent([String: RouterTarget].self, forKey: .targets) ?? [:]
    presence = try values.decodeIfPresent(RouterPresence.self, forKey: .presence)
    capabilities = try values.decodeIfPresent(CapabilitySnapshotV1.self, forKey: .capabilities)
    accountUsage = try values.decodeIfPresent(CodexAccountUsage.self, forKey: .accountUsage)
    providerUsage = try values.decodeIfPresent(ProviderUsageSnapshot.self, forKey: .providerUsage)
  }

  private enum CodingKeys: String, CodingKey { case targets, presence, capabilities, accountUsage, providerUsage }
}

struct DailyUsagePoint: Identifiable, Equatable {
  let date: Date
  let tokens: Double
  var id: Date { date }
}

struct UsageProviderChoice: Identifiable {
  let id: String
  let displayName: String
  let shortName: String
  let detail: String
  let isEnabled: Bool
}

struct DesktopQuotaRow: Identifiable {
  let id: String
  let providerID: String
  let providerName: String
  let label: String
  let remainingPercent: Double
  let resetAt: TimeInterval?
}

// MARK: - Tool-result aging model retained by the local Dynamic Island

struct ToolResultAgingStats: Decodable {
  let requests: Int?
  let evaluatedRequests: Int?
  let largestResultBytes: Int?
  let resultsAged: Int?
  let bytesSaved: Int?
  let estimatedTokensSaved: Int?
  let ranges: [String: ToolResultAgingRange]?

  var savingsSummary: String? {
    guard let requests, requests > 0, let estimatedTokensSaved, let bytesSaved else {
      guard let evaluatedRequests, evaluatedRequests > 0 else { return nil }
      let largestBytes = largestResultBytes ?? 0
      let largest = Self.compactBytes(largestBytes)
      if largestBytes > Self.agingMinBytes {
        return "Nothing aged yet in \(evaluatedRequests) requests (largest \(largest))"
      }
      return "No result over 32 KB in \(evaluatedRequests) requests (largest \(largest))"
    }
    let tokens = Self.compactCount(estimatedTokensSaved)
    let megabytes = String(format: "%.1f", Double(bytesSaved) / 1_048_576)
    return "Saved ~\(tokens) tokens (\(megabytes) MB) across \(requests) requests"
  }

  static let agingMinBytes = 32 * 1024

  static func compactBytes(_ value: Int) -> String {
    if value >= 1_048_576 { return String(format: "%.1f MB", Double(value) / 1_048_576) }
    if value >= 1_024 { return String(format: "%.0f KB", Double(value) / 1_024) }
    return "\(value) B"
  }

  static func compactCount(_ value: Int) -> String {
    if value >= 1_000_000 { return String(format: "%.1fM", Double(value) / 1_000_000) }
    if value >= 1_000 { return String(format: "%.1fk", Double(value) / 1_000) }
    return String(value)
  }
}

struct ToolResultAgingRange: Decodable {
  let savedTokens: Int?
  let requests: Int?
  let buckets: [Int]?
  let cache: ToolResultAgingCache?
}

struct ToolResultAgingCache: Decodable {
  let agedRate: Double?
  let unagedRate: Double?
  let agedTurns: Int?
  let unagedTurns: Int?
}

// MARK: - Local preferences and Router state

enum IslandMode: String, CaseIterable, Identifiable {
  case off
  case notch
  case desktop

  var id: String { rawValue }
  var label: String {
    switch self {
    case .off: return routerLocalized("Off")
    case .notch: return routerLocalized("Notch")
    case .desktop: return routerLocalized("Desktop")
    }
  }
}

enum TrayMenuBarDisplayMode: String, CaseIterable, Identifiable, Equatable {
  case standard
  case iconOnly
  var id: String { rawValue }
  var label: String { self == .standard ? routerLocalized("Standard") : routerLocalized("Icon only") }
}

enum TrayMenuBarIconStyle: String, CaseIterable, Identifiable, Equatable {
  case provider
  case indicator
  case preset
  case custom
  var id: String { rawValue }
  var label: String {
    switch self {
    case .provider: return routerLocalized("Provider icon")
    case .indicator: return routerLocalized("Activity dot")
    case .preset: return routerLocalized("Preset icon")
    case .custom: return routerLocalized("Custom image")
    }
  }
}

enum TrayPresenceMode: String, CaseIterable, Identifiable {
  case always
  case followCodex
  var id: String { rawValue }
  var label: String { self == .always ? routerLocalized("Always") : routerLocalized("With Codex") }
  var controlValue: String { self == .always ? "always" : "follow-codex" }
}

enum MenuBarCustomIconError: Error, Equatable { case tooLarge }

struct MenuBarSettings: Equatable {
  var displayMode: TrayMenuBarDisplayMode
  var showModelName: Bool
  var iconStyle: TrayMenuBarIconStyle
  var presetIcon: String
  var customIconPath: String?
}

enum MenuBarLayoutMetrics {
  static let standardReservedWidth: CGFloat = 180
  static let iconOnlyWidth: CGFloat = 24

  nonisolated static func statusItemWidth(displayMode: TrayMenuBarDisplayMode) -> CGFloat {
    displayMode == .iconOnly ? iconOnlyWidth : standardReservedWidth
  }

  nonisolated static func showsActivityBadge(iconStyle: TrayMenuBarIconStyle, isIdle: Bool) -> Bool {
    iconStyle != .indicator && !isIdle
  }
}

@MainActor
final class RouterStore: ObservableObject {
  static let shared = RouterStore()

  @Published private(set) var snapshot = RouterSnapshot.empty
  @Published private(set) var capabilitySnapshot = CapabilitySnapshotV1.empty
  @Published private(set) var isRefreshing = false
  @Published private(set) var message: String?
  @Published private(set) var lastUpdated: Date?
  @Published private(set) var selectedUsageProviderID = "openai"
  @Published private(set) var activityState: RouterActivityState = .idle
  @Published private(set) var activeRequests: [RouterActiveRequest] = []
  @Published private(set) var activeRequestCount = 0
  @Published private(set) var activeModel: String?
  @Published private(set) var activitySessionName: String?
  @Published private(set) var accountUsage: CodexAccountUsage?
  @Published private(set) var providerUsage: ProviderUsageSnapshot?
  @Published private(set) var islandMode: IslandMode
  @Published private(set) var menuBarDisplayMode: TrayMenuBarDisplayMode
  @Published private(set) var menuBarShowModelName: Bool
  @Published private(set) var menuBarIconStyle: TrayMenuBarIconStyle
  @Published private(set) var menuBarPresetIcon: String
  @Published private(set) var menuBarCustomIconPath: String?
  @Published private(set) var menuBarCustomIconImage: NSImage?
  @Published private(set) var menuBarCustomIconMissing = false
  @Published private(set) var language: TrayLanguage = RouterLanguage.selection
  @Published private(set) var presenceMode: TrayPresenceMode
  @Published private(set) var hostAppRunning = true
  @Published private(set) var surfacesVisible = true
  @Published private(set) var routerPinsServiceOn = false

  private let defaults = UserDefaults.standard
  private let islandVisibilityKey = "ModelRouterTray.islandVisible"
  private let islandModeKey = "ModelRouterTray.islandMode"
  private let menuBarDisplayModeKey = "ModelRouterTray.menuBarDisplayMode"
  private let menuBarShowModelNameKey = "ModelRouterTray.menuBarShowModelName"
  private let menuBarIconStyleKey = "ModelRouterTray.menuBarIconStyle"
  private let menuBarPresetIconKey = "ModelRouterTray.menuBarPresetIcon"
  private let menuBarCustomIconPathKey = "ModelRouterTray.menuBarCustomIconPath"
  private let presenceModeKey = "ModelRouterTray.presenceMode"
  private let hostAppAbsenceGrace = Duration.seconds(30)
  private let hostAppRecheckInterval = Duration.seconds(5)
  private var pendingServiceStop: Task<Void, Never>?
  private var bridge = DesktopCommandBridge()
  private var polling = false

  nonisolated static func resolveIslandMode(
    storedMode: String?,
    legacyVisible: Bool?,
    hasLaunchedBefore: Bool
  ) -> IslandMode {
    if let storedMode, let mode = IslandMode(rawValue: storedMode) { return mode }
    if let legacyVisible { return legacyVisible ? .notch : .off }
    return hasLaunchedBefore ? .notch : .off
  }

  nonisolated static func resolveMenuBarSettings(
    storedDisplayMode: String?,
    storedShowModelName: Bool?,
    storedIconStyle: String?,
    storedPresetIcon: String?,
    storedCustomIconPath: String?
  ) -> MenuBarSettings {
    let custom = storedCustomIconPath.flatMap { $0.isEmpty ? nil : $0 }
    let preset = storedPresetIcon.flatMap { $0.isEmpty ? nil : $0 } ?? "cpu"
    return MenuBarSettings(
      displayMode: storedDisplayMode.flatMap(TrayMenuBarDisplayMode.init(rawValue:)) ?? .standard,
      showModelName: storedShowModelName ?? true,
      iconStyle: storedIconStyle.flatMap(TrayMenuBarIconStyle.init(rawValue:)) ?? .indicator,
      presetIcon: preset,
      customIconPath: custom
    )
  }

  nonisolated static let customMenuBarIconMaxBytes = 5 * 1024 * 1024

  nonisolated static func persistCustomMenuBarIcon(
    from source: URL,
    into applicationSupportDirectory: URL,
    fileManager: FileManager = .default,
    maxBytes: Int = RouterStore.customMenuBarIconMaxBytes
  ) throws -> URL {
    let size = (try fileManager.attributesOfItem(atPath: source.path)[.size] as? NSNumber)?.intValue ?? 0
    if size > maxBytes { throw MenuBarCustomIconError.tooLarge }
    let dir = applicationSupportDirectory.appendingPathComponent("ModelRouterTray", isDirectory: true)
    try fileManager.createDirectory(at: dir, withIntermediateDirectories: true)
    let ext = source.pathExtension.isEmpty ? "png" : source.pathExtension.lowercased()
    let dest = dir.appendingPathComponent("menu-bar-icon.\(ext)")
    let staging = dir.appendingPathComponent("menu-bar-icon.\(UUID().uuidString).tmp")
    do {
      try fileManager.copyItem(at: source, to: staging)
      if fileManager.fileExists(atPath: dest.path) {
        _ = try fileManager.replaceItemAt(dest, withItemAt: staging)
      } else {
        try fileManager.moveItem(at: staging, to: dest)
      }
    } catch {
      try? fileManager.removeItem(at: staging)
      throw error
    }
    if let leftovers = try? fileManager.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil) {
      for leftover in leftovers where leftover.lastPathComponent.hasPrefix("menu-bar-icon.") && leftover.lastPathComponent != dest.lastPathComponent {
        try? fileManager.removeItem(at: leftover)
      }
    }
    return dest
  }

  nonisolated static func loadCustomMenuBarIcon(path: String?) -> (image: NSImage?, missing: Bool) {
    guard let path, !path.isEmpty else { return (nil, false) }
    guard let image = NSImage(contentsOfFile: path) else { return (nil, true) }
    return (image, false)
  }

  nonisolated static func menuBarTooltip(provider: String, state: String, usage: String?) -> String {
    if let usage { return routerFormat("Codex Router · %@ (%@) · %@", provider, state, usage) }
    return routerFormat("Codex Router · %@ (%@)", provider, state)
  }

  init() {
    let resolvedIslandMode = Self.resolveIslandMode(
      storedMode: defaults.string(forKey: islandModeKey),
      legacyVisible: defaults.object(forKey: islandVisibilityKey) == nil ? nil : defaults.bool(forKey: islandVisibilityKey),
      hasLaunchedBefore: defaults.object(forKey: islandModeKey) != nil
    )
    islandMode = resolvedIslandMode
    if defaults.string(forKey: islandModeKey) == nil { defaults.set(resolvedIslandMode.rawValue, forKey: islandModeKey) }
    let menu = Self.resolveMenuBarSettings(
      storedDisplayMode: defaults.string(forKey: menuBarDisplayModeKey),
      storedShowModelName: defaults.object(forKey: menuBarShowModelNameKey) == nil ? nil : defaults.bool(forKey: menuBarShowModelNameKey),
      storedIconStyle: defaults.string(forKey: menuBarIconStyleKey),
      storedPresetIcon: defaults.string(forKey: menuBarPresetIconKey),
      storedCustomIconPath: defaults.string(forKey: menuBarCustomIconPathKey)
    )
    menuBarDisplayMode = menu.displayMode
    menuBarShowModelName = menu.showModelName
    menuBarIconStyle = menu.iconStyle
    menuBarPresetIcon = menu.presetIcon
    menuBarCustomIconPath = menu.customIconPath
    menuBarCustomIconImage = Self.loadCustomMenuBarIcon(path: menu.customIconPath).image
    menuBarCustomIconMissing = Self.loadCustomMenuBarIcon(path: menu.customIconPath).missing
    if let raw = defaults.string(forKey: presenceModeKey), let mode = TrayPresenceMode(rawValue: raw) {
      presenceMode = mode
    } else {
      presenceMode = .always
    }
  }

  var codexActive: Bool { snapshot.targets["codex"]?.active == true }
  var activeChatCount: Int { activeRequests.count }
  var hasConcurrentActivity: Bool { activeRequests.count > 1 }
  var activitySummaryLabel: String {
    if activeRequests.isEmpty { return routerLocalized("Ready") }
    return routerFormat("%d chats", activeRequests.count)
  }

  var usageProviderChoices: [UsageProviderChoice] {
    var values = [UsageProviderChoice(id: "openai", displayName: "ChatGPT", shortName: "ChatGPT", detail: routerLocalized("Codex subscription"), isEnabled: true)]
    for provider in providerUsage?.providers ?? [] {
      values.append(UsageProviderChoice(id: provider.id, displayName: provider.displayName, shortName: provider.displayName, detail: provider.scope, isEnabled: true))
    }
    return values
  }

  var selectedUsageProvider: UsageProviderChoice {
    usageProviderChoices.first(where: { $0.id == selectedUsageProviderID }) ?? usageProviderChoices[0]
  }

  var selectedUsageUsesChatGPT: Bool { selectedUsageProviderID == "openai" }
  var selectedProviderUsage: RouterProviderUsage? { providerUsage?.providers.first(where: { $0.id == selectedUsageProviderID }) }
  var selectedAccountMetric: ProviderAccountMetric? { selectedProviderUsage?.account.metrics.first }
  var selectedTodayTokens: Double {
    if selectedUsageUsesChatGPT { return Double(accountUsage?.dailyUsageBuckets.last?.tokens ?? 0) }
    return Double(selectedProviderUsage?.dailyUsageBuckets.last?.tokens ?? 0)
  }
  var selectedUsageResetDate: Date? {
    if selectedUsageUsesChatGPT { return accountUsage?.primary?.resetDate }
    return selectedAccountMetric?.resetDate
  }

  func dailyUsage(days: Int) -> [DailyUsagePoint] {
    let buckets = selectedUsageUsesChatGPT ? accountUsage?.dailyUsageBuckets.map { ($0.startDate, $0.tokens) } ?? [] : selectedProviderUsage?.dailyUsageBuckets.map { ($0.startDate, $0.tokens) } ?? []
    let calendar = Calendar(identifier: .gregorian)
    let today = calendar.startOfDay(for: Date())
    return (0..<days).map { index in
      let date = calendar.date(byAdding: .day, value: -(days - 1 - index), to: today) ?? today
      let key = Self.dayFormatter.string(from: date)
      let tokens = buckets.first(where: { $0.0.hasPrefix(key) })?.1 ?? 0
      return DailyUsagePoint(date: date, tokens: Double(tokens))
    }
  }

  var desktopQuotaRows: [DesktopQuotaRow] {
    var rows: [DesktopQuotaRow] = []
    if let window = accountUsage?.primary {
      rows.append(DesktopQuotaRow(id: "openai-primary", providerID: "openai", providerName: "ChatGPT", label: window.durationLabel, remainingPercent: Double(window.remainingPercent), resetAt: window.resetsAt))
    }
    for provider in providerUsage?.providers ?? [] {
      for (index, metric) in provider.account.metrics.enumerated() where metric.kind == "quota" {
        rows.append(DesktopQuotaRow(id: "\(provider.id)-\(index)", providerID: provider.id, providerName: provider.displayName, label: metric.label, remainingPercent: remainingQuotaPercent(metric) ?? 0, resetAt: metric.resetAt))
      }
    }
    return rows
  }

  func sessionName(for request: RouterActiveRequest) -> String {
    request.sessionName ?? request.agentNickname ?? request.agentName ?? routerLocalized("Active session")
  }

  func modelLabel(for request: RouterActiveRequest) -> String {
    request.model?.split(separator: "/").last.map(String.init) ?? routerLocalized("Model Router")
  }

  func selectUsageProvider(_ providerID: String) { selectedUsageProviderID = providerID }

  func revealForUserLaunch() { surfacesVisible = true }

  func setIslandMode(_ mode: IslandMode) {
    islandMode = mode
    defaults.set(mode.rawValue, forKey: islandModeKey)
  }

  func setLanguage(_ next: TrayLanguage) {
    RouterLanguage.setSelection(next)
    language = next
  }

  func setMenuBarDisplayMode(_ mode: TrayMenuBarDisplayMode) { menuBarDisplayMode = mode; defaults.set(mode.rawValue, forKey: menuBarDisplayModeKey) }
  func setMenuBarShowModelName(_ show: Bool) { menuBarShowModelName = show; defaults.set(show, forKey: menuBarShowModelNameKey) }
  func setMenuBarIconStyle(_ style: TrayMenuBarIconStyle) { menuBarIconStyle = style; defaults.set(style.rawValue, forKey: menuBarIconStyleKey) }
  func setMenuBarPresetIcon(_ icon: String) { menuBarPresetIcon = icon; defaults.set(icon, forKey: menuBarPresetIconKey) }

  func setMenuBarCustomIcon(from url: URL) {
    do {
      let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
      let stored = try Self.persistCustomMenuBarIcon(from: url, into: support)
      menuBarCustomIconPath = stored.path
      defaults.set(stored.path, forKey: menuBarCustomIconPathKey)
      let loaded = Self.loadCustomMenuBarIcon(path: stored.path)
      menuBarCustomIconImage = loaded.image
      menuBarCustomIconMissing = loaded.missing
    } catch {
      message = error.localizedDescription
    }
  }

  func clearMenuBarCustomIcon() {
    menuBarCustomIconPath = nil
    menuBarCustomIconImage = nil
    menuBarCustomIconMissing = false
    defaults.removeObject(forKey: menuBarCustomIconPathKey)
  }

  func retireLoginItem() {}
  func restoreServiceOnQuit() {}
  func startHostAppObservation() { refreshHostAppRunning() }

  private func refreshSurfacesVisible() {
    let next = presenceMode == .always || hostAppRunning || routerPinsServiceOn
    guard surfacesVisible != next else { return }
    Task { @MainActor [weak self] in
      try? await Task.sleep(nanoseconds: 1_000_000_000)
      guard let self else { return }
      surfacesVisible = next
    }
  }

  private func refreshHostAppRunning() {
    hostAppRunning = true
    refreshSurfacesVisible()
  }

  private func schedulePresenceStop() {
    guard pendingServiceStop == nil else { return }
    pendingServiceStop = Task { @MainActor [weak self] in
      guard let self else { return }
      try? await Task.sleep(for: hostAppAbsenceGrace)
      self.refreshHostAppRunning()
      guard activeRequestCount == 0 && activityState == .idle else { return }
      await runServiceCommand("stop")
      pendingServiceStop = nil
    }
  }

  private func runServiceCommand(_ action: String) async {
    let command = action == "stop" ? "lifecycle.stop" : "lifecycle.start"
    _ = try? await executeCanonicalCommand(command)
  }

  func setPresenceMode(_ mode: TrayPresenceMode) {
    presenceMode = mode
    defaults.set(mode.rawValue, forKey: presenceModeKey)
    Task { _ = try? await executeCanonicalCommand("presence.mode", arguments: ["mode": mode.controlValue]) }
    if mode != .always { schedulePresenceStop() }
    refreshSurfacesVisible()
  }

  func startPolling() async {
    guard !polling else { return }
    polling = true
    await refresh()
  }

  func startActivityPolling() async { await refreshActivity() }
  func startAccountUsagePolling() async { await refreshAccountUsage() }
  func startProviderPolling() async { await refreshProviderUsage() }

  private func refreshActivity() async {
    do {
      guard let value = try await executeCanonicalCommand("lifecycle.status"), case .object(let object) = value else { return }
      if case let .some(.string(state)) = object["state"], let next = RouterActivityState(rawValue: state) { activityState = next }
    } catch {
      // Status polling is best-effort; the main snapshot owns the user-facing error.
    }
  }

  private func refreshAccountUsage() async {
    do {
      guard let value = try await executeCanonicalCommand("native.account-usage") else { return }
      let data = try JSONEncoder().encode(value)
      accountUsage = try JSONDecoder().decode(CodexAccountUsage.self, from: data)
    } catch {
      // Usage can be unavailable while the local session is refreshing.
    }
  }

  private func refreshProviderUsage() async {
    do {
      guard let value = try await executeCanonicalCommand("usage.router") else { return }
      let data = try JSONEncoder().encode(value)
      providerUsage = try JSONDecoder().decode(ProviderUsageSnapshot.self, from: data)
    } catch {
      // Usage can be unavailable while the local session is refreshing.
    }
  }

  func refresh() async {
    isRefreshing = true
    defer { isRefreshing = false }
    do {
      guard let value = try await executeCanonicalCommand("lifecycle.status") else { throw RouterError("The Router returned no status.") }
      let data = try JSONEncoder().encode(value)
      let decoded = try JSONDecoder().decode(RouterSnapshot.self, from: data)
      snapshot = decoded
      capabilitySnapshot = decoded.capabilities ?? CapabilitySnapshotV1.empty
      accountUsage = decoded.accountUsage ?? accountUsage
      providerUsage = decoded.providerUsage ?? providerUsage
      lastUpdated = Date()
      message = nil
    } catch {
      message = error.localizedDescription
    }
  }

  func executeCanonicalCommand(
    _ command: String,
    arguments: [String: Any] = [:],
    protectedInput: String? = nil
  ) async throws -> JSONValue? {
    guard CapabilityCommandCatalog.canonicalCommandSet.contains(command) else {
      throw RouterError("Unsupported Router command.")
    }
    if command != "lifecycle.status" && !capabilitySnapshot.isCompatible {
      throw RouterError(capabilitySnapshot.incompatibilityText)
    }
    let data = try await bridge.execute(command, arguments: arguments, protectedInput: protectedInput)
    let envelope = try JSONDecoder().decode(DesktopCommandEnvelope<JSONValue>.self, from: data)
    guard envelope.ok else {
      guard let error = envelope.error else { throw RouterError("The Router command failed.") }
      let code = error.code
      throw RouterError("\(code): \(error.message)")
    }
    return envelope.value
  }

  func execute(command: CapabilityCommand, fields: [String: String], protectedInput: String?) async {
    var arguments: [String: Any] = [:]
    for (name, definition) in command.arguments.properties {
      let value = fields[name] ?? ""
      if definition.type.contains("boolean") {
        arguments[name] = value == "true"
      } else if definition.type.contains("integer") {
        arguments[name] = value.isEmpty ? NSNull() : Int(value) ?? 0
      } else {
        arguments[name] = value
      }
    }
    do {
      _ = try await executeCanonicalCommand(command.name, arguments: arguments, protectedInput: protectedInput)
      message = "\(command.name) applied."
      if command.name == "credential.set" { await refreshProviderUsage() }
      await refresh()
    } catch {
      message = error.localizedDescription
    }
  }

  static let dayFormatter: DateFormatter = {
    let formatter = DateFormatter()
    formatter.locale = Locale(identifier: "en_US_POSIX")
    formatter.dateFormat = "yyyy-MM-dd"
    return formatter
  }()
}

// MARK: - Small visual shell

private struct MenuBarIconView: View {
  @ObservedObject var store: RouterStore
  var size: CGFloat = 13

  var body: some View {
    Group {
      switch store.menuBarIconStyle {
      case .provider:
        ProviderIcon(providerID: store.selectedUsageProviderID, size: size, showsHelp: false)
      case .indicator:
        Circle().fill(store.activityState.tint).frame(width: 6, height: 6)
      case .preset:
        Image(systemName: store.menuBarPresetIcon).font(.system(size: size, weight: .medium))
      case .custom:
        if let image = store.menuBarCustomIconImage {
          Image(nsImage: image).resizable().scaledToFit().frame(width: size, height: size)
        } else {
          Image(systemName: "cpu").font(.system(size: size, weight: .medium))
        }
      }
    }
  }
}

private struct StatusItemLabel: View {
  @ObservedObject var store: RouterStore
  @State private var pulse = false

  var body: some View {
    HStack(spacing: 6) {
      MenuBarIconView(store: store)
      if store.menuBarDisplayMode == .standard && store.menuBarShowModelName {
        Text(store.selectedUsageProvider.shortName).lineLimit(1)
      }
    }
    .frame(width: MenuBarLayoutMetrics.statusItemWidth(displayMode: store.menuBarDisplayMode), alignment: .leading)
    .task(id: store.activityState.rawValue) {
      pulse = store.activityState != .idle
    }
    .accessibilityLabel(RouterStore.menuBarTooltip(provider: store.selectedUsageProvider.shortName, state: store.activityState.label, usage: nil))
  }
}

private struct StatusBeacon: View {
  let state: RouterActivityState
  var body: some View {
    Circle().fill(state.tint).frame(width: 8, height: 8)
      .task(id: state.rawValue) { _ = state }
  }
}

private struct OperationPulse: View {
  let active: Bool
  var body: some View {
    ProgressView().controlSize(.small).opacity(active ? 1 : 0)
  }
}

private struct AccentButtonStyle: ButtonStyle {
  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .foregroundStyle(configuration.isPressed ? routerAccent.opacity(0.72) : routerAccent)
  }
}

private struct CapabilityTrayView: View {
  @ObservedObject var store: RouterStore

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      header
      Divider()
      if store.capabilitySnapshot.isCompatible {
        ScrollView {
          LazyVStack(alignment: .leading, spacing: 12) {
            ForEach(store.capabilitySnapshot.capabilities) { capability in
              CapabilitySectionView(store: store, capability: capability)
            }
          }
          .padding(14)
        }
      } else {
        IncompatibleCapabilityView(snapshot: store.capabilitySnapshot)
      }
    }
    .frame(width: 370, height: 590)
    .background(.regularMaterial)
  }

  private var header: some View {
    HStack(spacing: 9) {
      StatusBeacon(state: store.activityState)
      VStack(alignment: .leading, spacing: 2) {
        Text(routerLocalized("Model Router")).font(.headline)
        Text(store.capabilitySnapshot.isCompatible ? routerLocalized("Capability-driven controls") : routerLocalized("Read-only compatibility status"))
          .font(.caption)
          .foregroundStyle(routerMuted)
      }
      Spacer()
      OperationPulse(active: store.isRefreshing)
    }
    .padding(14)
  }
}

private struct IncompatibleCapabilityView: View {
  let snapshot: CapabilitySnapshotV1

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      Image(systemName: "exclamationmark.triangle").foregroundStyle(routerYellow)
      Text(routerLocalized("Router capability update required")).font(.headline)
      Text(snapshot.incompatibilityText).font(.subheadline).foregroundStyle(routerMuted)
      Text(routerFormat("Capability schema %d", snapshot.capabilitySchemaVersion)).font(.caption.monospaced()).foregroundStyle(routerMuted)
      Text(routerLocalized("Refresh after updating the Router.")).font(.caption).foregroundStyle(routerMuted)
    }
    .padding(18)
  }
}

private struct CapabilitySectionView: View {
  @ObservedObject var store: RouterStore
  let capability: CapabilityDescription

  var body: some View {
    VStack(alignment: .leading, spacing: 7) {
      HStack {
        Text(capability.id.replacingOccurrences(of: "-", with: " ").capitalized).font(.subheadline.weight(.semibold))
        Spacer()
        Text("\(capability.nodeCommands.count)").font(.caption.monospaced()).foregroundStyle(routerMuted)
      }
      ForEach(capability.nodeCommands.compactMap(store.capabilitySnapshot.command), id: \.id) { command in
        CapabilityCommandRow(store: store, command: command)
      }
    }
  }
}

private struct CapabilityCommandRow: View {
  @ObservedObject var store: RouterStore
  let command: CapabilityCommand
  @State private var fields: [String: String]
  @State private var protectedValue = ""
  @State private var confirmationPresented = false

  init(store: RouterStore, command: CapabilityCommand) {
    self.store = store
    self.command = command
    _fields = State(initialValue: command.arguments.properties.reduce(into: [:]) { result, item in
      result[item.key] = Self.defaultValue(for: item.key, type: item.value.type)
    })
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 5) {
      HStack(spacing: 7) {
        Image(systemName: command.isMutating ? "slider.horizontal.3" : "waveform.path.ecg")
          .foregroundStyle(command.isMutating ? routerAccent : routerMuted)
        Text(command.name).font(.caption.monospaced())
        Spacer()
        if command.hasQuotaWarning { Text(routerLocalized("Quota warning")).font(.caption2).foregroundStyle(routerYellow) }
      }
      ForEach(command.arguments.properties.keys.sorted(), id: \.self) { name in
        TextField(name, text: Binding(
          get: { fields[name, default: ""] },
          set: { fields[name] = $0 }
        ))
        .textFieldStyle(.roundedBorder)
        .font(.caption)
      }
      if command.protectedInput {
        SecureField(routerLocalized("Enter credential for this one-time operation"), text: $protectedValue)
          .textFieldStyle(.roundedBorder)
          .textContentType(.password)
          .onSubmit { submit() }
      }
      if command.hasQuotaWarning {
        Text(routerLocalized("This operation may consume provider quota. Check the provider plan before continuing."))
          .font(.caption2)
          .foregroundStyle(routerMuted)
      }
      Button(command.requiresConfirmation ? routerLocalized("Confirm and run") : routerLocalized("Run")) {
        if command.requiresConfirmation { confirmationPresented = true } else { submit() }
      }
      .buttonStyle(AccentButtonStyle())
      .confirmationDialog(routerLocalized("Confirm this Router operation?"), isPresented: $confirmationPresented) {
        Button(routerLocalized("Confirm"), role: .destructive) { submit() }
        Button(routerLocalized("Cancel"), role: .cancel) {}
      } message: {
        Text(command.hasQuotaWarning ? routerLocalized("This action may use quota.") : routerLocalized("The Router will apply this change."))
      }
    }
    .padding(.vertical, 5)
  }

  private func submit() {
    let secret = command.protectedInput ? protectedValue : nil
    Task {
      await store.execute(command: command, fields: fields, protectedInput: secret)
      if command.protectedInput { protectedValue = "" }
    }
  }

  private static func defaultValue(for name: String, type: String) -> String {
    if name == "provider" { return "deepseek" }
    if name == "slug" { return "deepseek/deepseek-v4-pro" }
    if name == "mode" { return "proven" }
    if name == "selection" { return "select-all" }
    if name == "engine" { return "auto" }
    if name == "effort" { return "default" }
    if name == "tag" { return "qwen2.5vl:3b" }
    if name == "days" { return "7" }
    if type.contains("boolean") { return "true" }
    return ""
  }
}

private struct CapabilitySettingsView: View {
  @ObservedObject var store: RouterStore

  var body: some View {
    Form {
      Section(routerLocalized("Dynamic Island")) {
        Picker(routerLocalized("Presentation"), selection: Binding(get: { store.islandMode }, set: store.setIslandMode)) {
          ForEach(IslandMode.allCases) { mode in Text(mode.label).tag(mode) }
        }
        Text(routerLocalized("This presentation preference stays local to the Swift tray.")).font(.caption).foregroundStyle(routerMuted)
      }
      Section(routerLocalized("Menu bar")) {
        Picker(routerLocalized("Layout"), selection: Binding(get: { store.menuBarDisplayMode }, set: store.setMenuBarDisplayMode)) {
          ForEach(TrayMenuBarDisplayMode.allCases) { mode in Text(mode.label).tag(mode) }
        }
        Toggle(routerLocalized("Show provider name"), isOn: Binding(get: { store.menuBarShowModelName }, set: store.setMenuBarShowModelName))
      }
      Section(routerLocalized("Language")) {
        Picker(routerLocalized("Language"), selection: Binding(get: { store.language }, set: store.setLanguage)) {
          ForEach(TrayLanguage.allCases) { language in Text(language.label).tag(language) }
        }
      }
    }
    .formStyle(.grouped)
    .frame(width: 390, height: 320)
    .padding(10)
  }
}

@main
struct ModelRouterTrayApp: App {
  @NSApplicationDelegateAdaptor private var appDelegate: AppDelegate
  @ObservedObject private var store = RouterStore.shared

  var body: some Scene {
    MenuBarExtra(isInserted: Binding(get: { store.surfacesVisible }, set: { _ in })) {
      CapabilityTrayView(store: store)
    } label: {
      StatusItemLabel(store: store)
    }
    .menuBarExtraStyle(.window)

    Settings {
      CapabilitySettingsView(store: store)
    }
  }
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
  let store = RouterStore.shared
  private var islandController: IslandWindowController?
  private var desktopPanelController: DesktopPanelWindowController?
  private var surfaceVisibility: AnyCancellable?

  func applicationDidFinishLaunching(_ notification: Notification) {
    NSApp.setActivationPolicy(.accessory)
    islandController = IslandWindowController(store: store)
    desktopPanelController = DesktopPanelWindowController(store: store)
    surfaceVisibility = store.$surfacesVisible.combineLatest(store.$islandMode).sink { [weak self] visible, mode in
      Task { @MainActor [weak self] in
        self?.islandController?.setVisible(visible && mode == .notch)
        self?.desktopPanelController?.setVisible(visible && mode == .desktop)
      }
    }
    store.retireLoginItem()
    store.startHostAppObservation()
    Task { await store.startPolling() }
    Task { await store.startActivityPolling() }
    Task { await store.startAccountUsagePolling() }
    Task { await store.startProviderPolling() }
  }

  func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows: Bool) -> Bool {
    store.revealForUserLaunch()
    return true
  }

  func applicationWillTerminate(_ notification: Notification) { store.restoreServiceOnQuit() }
}

// Keep a small catalogue of presentation literals in this source so the
// localization parity guard sees the complete native surface, including the
// labels that are otherwise generated from the capability manifest at runtime.
private let routerSurfaceCopy = [
  routerLocalized("Model Router"), routerLocalized("Capability-driven controls"), routerLocalized("Read-only compatibility status"),
  routerLocalized("Router capability update required"), routerLocalized("Refresh after updating the Router."),
  routerLocalized("Quota warning"), routerLocalized("This operation may consume provider quota. Check the provider plan before continuing."),
  routerLocalized("Enter credential for this one-time operation"), routerLocalized("Confirm and run"), routerLocalized("Run"),
  routerLocalized("Confirm this Router operation?"), routerLocalized("The Router will apply this change."), routerLocalized("This action may use quota."), routerLocalized("Cancel"),
  routerLocalized("Dynamic Island"), routerLocalized("Presentation"), routerLocalized("This presentation preference stays local to the Swift tray."),
  routerLocalized("Menu bar"), routerLocalized("Layout"), routerLocalized("Show provider name"), routerLocalized("Language"),
  routerLocalized("Status"), routerLocalized("Settings"), routerLocalized("Usage"), routerLocalized("Ready"), routerLocalized("Active session"),
  routerLocalized("Current limit"), routerLocalized("Daily limit"), routerLocalized("Weekly limit"), routerLocalized("Codex subscription"),
  routerLocalized("Standard"), routerLocalized("Icon only"), routerLocalized("Provider icon"), routerLocalized("Activity dot"), routerLocalized("Preset icon"), routerLocalized("Custom image"),
  routerLocalized("Always"), routerLocalized("With Codex"), routerLocalized("Off"), routerLocalized("Notch"), routerLocalized("Desktop"),
  routerLocalized("Idle"), routerLocalized("Thinking"), routerLocalized("Starting"), routerLocalized("Error"), routerLocalized("Model Router"),
  routerLocalized("Connect a provider to see its quota here."), routerLocalized("No traffic"), routerLocalized("Router overview"), routerLocalized("Last used"),
  routerLocalized("Active now"), routerLocalized("Active provider"), routerLocalized("Running chats"), routerLocalized("Daily usage"), routerLocalized("Last 7 days"),
  routerLocalized("Tokens"), routerLocalized("Quota"), routerLocalized("Usage limit"), routerLocalized("No reset reported"), routerLocalized("Not reported by provider"),
  routerLocalized("Measured by this router"), routerLocalized("ChatGPT account usage"), routerLocalized("Router traffic"), routerLocalized("Open usage dashboard"),
  routerLocalized("Refresh"), routerLocalized("Quit"), routerLocalized("Update"), routerLocalized("Fix"), routerLocalized("Restart"), routerLocalized("Stop"),
  routerLocalized("Start"), routerLocalized("Apply"), routerLocalized("Save"), routerLocalized("Remove"), routerLocalized("Delete"), routerLocalized("Enable"),
  routerLocalized("Disable"), routerLocalized("Show all"), routerLocalized("Model picker"), routerLocalized("Subagent models"), routerLocalized("Failover"),
  routerLocalized("Tool-result aging"), routerLocalized("Vision Bridge"), routerLocalized("Presence"), routerLocalized("CC Switch"), routerLocalized("Native session"),
  routerLocalized("Account usage"), routerLocalized("Provider credentials"), routerLocalized("Provider model state"), routerLocalized("Protocol proof"), routerLocalized("Picker and catalog"),
  routerLocalized("Doctor and update"), routerLocalized("Lifecycle"), routerLocalized("Confirmation required"), routerLocalized("Protected input"), routerLocalized("Protected output"),
  routerLocalized("Schema version"), routerLocalized("Health"), routerLocalized("Version"), routerLocalized("Read-only"), routerLocalized("Compatible"),
  routerLocalized("The Router will apply this change."), routerLocalized("One-time operation"), routerLocalized("No credential is stored by the tray."), routerLocalized("Native presentation"),
  routerLocalized("Provider"), routerLocalized("Model"), routerLocalized("Engine"), routerLocalized("Effort"), routerLocalized("Selection"), routerLocalized("Mode"),
  routerLocalized("Days"), routerLocalized("Visible"), routerLocalized("Enabled"), routerLocalized("Expired only"), routerLocalized("Slug"), routerLocalized("Tag"),
  routerLocalized("OpenAI"), routerLocalized("DeepSeek"), routerLocalized("Qwen Plan"), routerLocalized("Catalog"), routerLocalized("Logs"), routerLocalized("Doctor"),
  routerLocalized("Maintenance"), routerLocalized("Account"), routerLocalized("Router command"), routerLocalized("Command result"), routerLocalized("Error details"), routerLocalized("Try again"),
  routerLocalized("The Router is unavailable."), routerLocalized("Awaiting data"), routerLocalized("Updated"), routerLocalized("Loading"), routerLocalized("Unavailable"), routerLocalized("Installed"),
  routerLocalized("Configured"), routerLocalized("Hidden"), routerLocalized("Visible in picker"), routerLocalized("Provider plan"), routerLocalized("Quota status"), routerLocalized("Reset"),
  routerLocalized("Today"), routerLocalized("Week"), routerLocalized("Month"), routerLocalized("Requests"), routerLocalized("Input tokens"), routerLocalized("Output tokens"),
  routerLocalized("Total tokens"), routerLocalized("Success"), routerLocalized("Failure"), routerLocalized("Retry"), routerLocalized("Cancel operation"), routerLocalized("Operation complete"),
  routerLocalized("Operation failed"), routerLocalized("Read-only status"), routerLocalized("Settings saved"), routerLocalized("Language changed"), routerLocalized("Presentation saved"), routerLocalized("Menu bar saved")
]

func remainingQuotaPercent(_ metric: ProviderAccountMetric) -> Double? {
  if let remaining = metric.remainingPercent { return max(0, min(100, remaining)) }
  guard let remaining = metric.remaining, let limit = metric.limit, limit > 0 else { return nil }
  return max(0, min(100, remaining / limit * 100))
}

func standardizedLimitLabel(_ label: String) -> String { label }

func formattedAccountMetric(_ metric: ProviderAccountMetric) -> String {
  if let value = metric.value { return String(format: "%.2f %@", value, metric.currency ?? metric.unit ?? "") }
  if let remaining = metric.remaining { return String(format: "%.2f", remaining) }
  return "—"
}

func usageResetCaption(_ date: Date) -> String {
  let seconds = date.timeIntervalSinceNow
  if seconds <= 0 { return routerLocalized("resets soon") }
  return date.formatted(date: .abbreviated, time: .shortened)
}

func compactTokenCount(_ value: Double) -> String {
  if value >= 1_000_000 { return String(format: "%.1fM", value / 1_000_000) }
  if value >= 1_000 { return String(format: "%.1fk", value / 1_000) }
  return String(Int(value.rounded()))
}
