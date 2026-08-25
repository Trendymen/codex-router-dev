import AppKit
import Combine
import Darwin
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

struct CapabilityFieldPresentation: Decodable {
  let label: String
  let localizationKey: String
  let type: String
  let required: Bool
  let enumValues: [String]

  init(from decoder: Decoder) throws {
    let values = try decoder.container(keyedBy: CodingKeys.self)
    label = try values.decodeIfPresent(String.self, forKey: .label) ?? "Field"
    localizationKey = try values.decodeIfPresent(String.self, forKey: .localizationKey) ?? "field.value"
    if let single = try? values.decode(String.self, forKey: .type) {
      type = single
    } else {
      type = (try values.decodeIfPresent([String].self, forKey: .type) ?? []).joined(separator: "|")
    }
    required = try values.decodeIfPresent(Bool.self, forKey: .required) ?? false
    enumValues = try values.decodeIfPresent([String].self, forKey: .enumValues) ?? []
  }

  private enum CodingKeys: String, CodingKey { case label, localizationKey, type, required, enumValues = "enum" }
}

struct CapabilityUI: Decodable {
  let title: String
  let localizationKey: String
  let control: String
  let confirmation: String
  let quotaWarning: String
  let resultKind: String
  let protectedField: String?
  let fields: [String: CapabilityFieldPresentation]

  init(from decoder: Decoder) throws {
    let values = try decoder.container(keyedBy: CodingKeys.self)
    title = try values.decodeIfPresent(String.self, forKey: .title) ?? "Router command"
    localizationKey = try values.decodeIfPresent(String.self, forKey: .localizationKey) ?? "capability.router"
    control = try values.decodeIfPresent(String.self, forKey: .control) ?? "read"
    confirmation = try values.decodeIfPresent(String.self, forKey: .confirmation) ?? "none"
    quotaWarning = try values.decodeIfPresent(String.self, forKey: .quotaWarning) ?? "none"
    resultKind = try values.decodeIfPresent(String.self, forKey: .resultKind) ?? "json"
    protectedField = try values.decodeIfPresent(String.self, forKey: .protectedField)
    fields = try values.decodeIfPresent([String: CapabilityFieldPresentation].self, forKey: .fields) ?? [:]
  }

  private enum CodingKeys: String, CodingKey {
    case title, localizationKey, control, confirmation, quotaWarning, resultKind, protectedField, fields
  }
}

struct CapabilityCommand: Decodable, Identifiable {
  let name: String
  let arguments: CapabilityArgumentSchema
  let isMutating: Bool
  let confirmation: Bool
  let quotaWarning: Bool
  let protectedInput: Bool
  let resultKind: String
  let ui: CapabilityUI

  var id: String { name }
  var requiresConfirmation: Bool { confirmation }
  var hasQuotaWarning: Bool { quotaWarning }

  init(from decoder: Decoder) throws {
    let values = try decoder.container(keyedBy: CodingKeys.self)
    name = try values.decode(String.self, forKey: .name)
    arguments = try values.decodeIfPresent(CapabilityArgumentSchema.self, forKey: .arguments) ?? CapabilityArgumentSchema()
    isMutating = try values.decodeIfPresent(Bool.self, forKey: .mutationFlag) ?? false
    confirmation = try values.decodeIfPresent(Bool.self, forKey: .confirmation) ?? false
    quotaWarning = try values.decodeIfPresent(Bool.self, forKey: .quotaWarning) ?? false
    protectedInput = try values.decodeIfPresent(Bool.self, forKey: .protectedInput) ?? false
    resultKind = try values.decodeIfPresent(String.self, forKey: .resultKind) ?? "json"
    ui = try values.decodeIfPresent(CapabilityUI.self, forKey: .ui)
      ?? CapabilityUI(title: "Router command", localizationKey: "capability.router", control: "read", confirmation: "none", quotaWarning: "none", resultKind: "json", protectedField: nil, fields: [:])
  }

  private enum CodingKeys: String, CodingKey {
    case name, arguments, mutationFlag = "mutating", confirmation, quotaWarning, protectedInput, resultKind, ui
  }
}

extension CapabilityUI {
  init(title: String, localizationKey: String, control: String, confirmation: String, quotaWarning: String, resultKind: String, protectedField: String?, fields: [String: CapabilityFieldPresentation]) {
    self.title = title
    self.localizationKey = localizationKey
    self.control = control
    self.confirmation = confirmation
    self.quotaWarning = quotaWarning
    self.resultKind = resultKind
    self.protectedField = protectedField
    self.fields = fields
  }
}

struct CapabilityDescription: Decodable, Identifiable {
  let id: String
  let localizationKey: String
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
    localizationKey = try values.decodeIfPresent(String.self, forKey: .localizationKey) ?? "capability.\(id)"
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
    case id, localizationKey, schemaVersion, nodeCommands, swift, browser, confirmation, quotaWarning, protectedInput, resultKind
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

  private enum CodingKeys: String, CodingKey {
    case capabilitySchemaVersion
    case compatibility
    case mutationsEnabled
    case commands
    case capabilities
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

// This envelope intentionally decodes a tiny, tolerant subset of the status
// result. A malformed/unknown capability payload must not make health/version
// disappear with it; the tray can still explain the compatibility state while
// keeping every mutation disabled.
struct HealthVersionEnvelope: Decodable {
  let health: String
  let version: String
  let capabilitySchemaVersion: Int?
  let compatibilityReason: String?

  static let empty = HealthVersionEnvelope(
    health: "unavailable",
    version: "unknown",
    capabilitySchemaVersion: nil,
    compatibilityReason: "status_unavailable"
  )

  init(health: String, version: String, capabilitySchemaVersion: Int?, compatibilityReason: String?) {
    self.health = health
    self.version = version
    self.capabilitySchemaVersion = capabilitySchemaVersion
    self.compatibilityReason = compatibilityReason
  }

  init(from decoder: Decoder) throws {
    let values = try decoder.container(keyedBy: CodingKeys.self)
    health = (try? values.decode(String.self, forKey: .health)) ?? "available"
    version = (try? values.decode(String.self, forKey: .version)) ?? "unknown"
    capabilitySchemaVersion = (try? values.decode(Int.self, forKey: .capabilitySchemaVersion))
      ?? ((try? values.decode(CapabilitySnapshotV1.self, forKey: .capabilities))?.capabilitySchemaVersion)
    compatibilityReason = (try? values.decode(CapabilityCompatibility.self, forKey: .compatibility))?.reason
      ?? ((try? values.decode(CapabilitySnapshotV1.self, forKey: .capabilities))?.compatibility.reason)
  }

  private enum CodingKeys: String, CodingKey {
    case health, version, capabilitySchemaVersion, compatibility, capabilities
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

struct CapabilityCommandResult: Identifiable {
  let id = UUID()
  let command: String
  let resultKind: String
  let value: JSONValue?
  let error: DesktopCommandError?

  var isError: Bool { error != nil }
  var text: String? {
    guard let value else { return nil }
    switch value {
    case .string(let text): return text
    case .number(let number): return String(number)
    case .bool(let flag): return flag ? "true" : "false"
    case .null: return "null"
    case .array, .object:
      guard let data = try? JSONEncoder().encode(value) else { return nil }
      return String(data: data, encoding: .utf8)
    }
  }
}

private struct RouterError: LocalizedError {
  let message: String
  init(_ message: String) { self.message = message }
  var errorDescription: String? { message }
}

private struct DesktopCommandBridge {
  private static let outputLimit = 256 * 1024
  private static let commandTimeout = Duration.seconds(120)
  private static let terminationGraceSeconds = 2.0
  private let root: URL?

  private enum BridgeFailure: LocalizedError, Sendable {
    case missingRoot
    case missingNode
    case missingBridge
    case cancelled
    case timedOut
    case outputLimit
    case invalidOutput

    var errorDescription: String? {
      switch self {
      case .missingRoot: return "Cannot find the signed Router checkout."
      case .missingNode: return "Cannot find the validated Node runtime."
      case .missingBridge: return "The Router command bridge is unavailable."
      case .cancelled: return "The Router command was cancelled."
      case .timedOut: return "The Router command timed out."
      case .outputLimit: return "The Router command returned too much output."
      case .invalidOutput: return "The Router command returned an unreadable response."
      }
    }
  }

  // Process termination, timeout, cancellation, and the "already exited"
  // check can all race.  Keep the continuation behind one lock so that a
  // child which exits before Foundation invokes terminationHandler cannot
  // resume the wait twice, and a timeout cannot turn a successful exit into a
  // second result.
  private final class ProcessCompletion: @unchecked Sendable {
    private let lock = NSLock()
    private var continuation: CheckedContinuation<Int32, Error>?
    private var pending: Result<Int32, Error>?
    private var completed = false

    var isCompleted: Bool {
      lock.lock()
      defer { lock.unlock() }
      return completed
    }

    func install(_ continuation: CheckedContinuation<Int32, Error>) {
      lock.lock()
      if let pending {
        lock.unlock()
        continuation.resume(with: pending)
        return
      }
      self.continuation = continuation
      lock.unlock()
    }

    @discardableResult
    func succeed(_ status: Int32) -> Bool {
      complete(.success(status))
    }

    @discardableResult
    func fail(_ error: BridgeFailure) -> Bool {
      complete(.failure(error))
    }

    @discardableResult
    private func complete(_ result: Result<Int32, Error>) -> Bool {
      lock.lock()
      guard !completed else {
        lock.unlock()
        return false
      }
      completed = true
      let continuation = self.continuation
      if continuation == nil { pending = result }
      lock.unlock()
      continuation?.resume(with: result)
      return true
    }
  }

  init(root: URL? = nil) {
    self.root = root ?? Self.sealedSourceRoot()
  }

  private static func sealedSourceRoot() -> URL? {
    guard let value = Bundle.main.object(forInfoDictionaryKey: "ModelRouterSourceRoot") as? String,
      !value.isEmpty,
      value.hasPrefix("/")
    else { return nil }
    let resolvedRoot = URL(fileURLWithPath: value).standardizedFileURL.resolvingSymlinksInPath()
    let control = resolvedRoot.appendingPathComponent("bin/control")
    guard FileManager.default.isExecutableFile(atPath: control.path) else { return nil }
    return resolvedRoot
  }

  private static func ownedExecutable(_ candidate: URL) -> URL? {
    let resolved = candidate.standardizedFileURL.resolvingSymlinksInPath()
    let fileManager = FileManager.default
    guard fileManager.isExecutableFile(atPath: resolved.path),
      let attributes = try? fileManager.attributesOfItem(atPath: resolved.path),
      attributes[.type] as? FileAttributeType == .typeRegular,
      let owner = attributes[.ownerAccountID] as? NSNumber
    else { return nil }
    let uid = NSNumber(value: Darwin.getuid())
    guard owner == uid || owner.intValue == 0 else { return nil }
    return resolved
  }

  private static func validatedNodeBinary(root: URL) -> URL? {
    var candidates: [URL] = []
    if let configured = ProcessInfo.processInfo.environment["CODEX_ROUTER_NODE_BIN"],
      !configured.isEmpty,
      configured.hasPrefix("/")
    {
      candidates.append(URL(fileURLWithPath: configured))
    }
    candidates.append(contentsOf: [
      root.appendingPathComponent(".runtime/node/bin/node"),
      root.appendingPathComponent(".node/bin/node"),
      URL(fileURLWithPath: "/opt/homebrew/bin/node"),
      URL(fileURLWithPath: "/usr/local/bin/node"),
      URL(fileURLWithPath: "/usr/bin/node"),
    ])
    return candidates.lazy.compactMap(ownedExecutable).first
  }

  private static func boundedRead(
    _ handle: FileHandle,
    limit: Int,
    terminate: @escaping () -> Void
  ) -> Data {
    var output = Data()
    do {
      while let chunk = try handle.read(upToCount: 16 * 1024), !chunk.isEmpty {
        let remaining = limit - output.count
        if remaining <= 0 {
          terminate()
          break
        }
        if chunk.count > remaining {
          output.append(contentsOf: chunk.prefix(remaining))
          terminate()
          break
        }
        output.append(chunk)
      }
    } catch {
      terminate()
    }
    return output
  }

  private static func zeroize(_ data: inout Data) {
    data.withUnsafeMutableBytes { buffer in
      guard let baseAddress = buffer.baseAddress else { return }
      _ = Darwin.memset(baseAddress, 0, buffer.count)
    }
    data.removeAll(keepingCapacity: false)
  }

  private static func isEnvelope(_ data: Data) -> Bool {
    guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return false }
    return object["ok"] is Bool && (object["value"] != nil || object["error"] != nil)
  }

  // Escalation runs outside the caller's cancellation state. Once TERM has
  // been sent, cancellation must still leave a bounded grace period before
  // the final KILL and must not strand a child that ignores TERM.
  private static func terminateProcess(_ process: Process) async {
    let worker = Task.detached(priority: .userInitiated) { [process] in
      if process.isRunning { process.terminate() }
      try? await Task.sleep(for: .seconds(Self.terminationGraceSeconds))
      if process.isRunning { Darwin.kill(process.processIdentifier, SIGKILL) }
    }
    await worker.value
  }

  private static func waitForProcess(_ process: Process, completion: ProcessCompletion) async throws -> Int32 {
    try await withTaskCancellationHandler {
      try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Int32, Error>) in
        completion.install(continuation)
        // A very short-lived helper can finish between run() and installing
        // the continuation. The completion lock makes this check harmless
        // when terminationHandler won the race.
        if !process.isRunning { completion.succeed(process.terminationStatus) }
      }
    } onCancel: {
      guard !completion.isCompleted else { return }
      // Mark the result first so the waiter resumes once. The caller's catch
      // path owns the bounded TERM/grace/KILL escalation below; doing it here
      // would race the timeout task and leave two independent killers.
      guard completion.fail(.cancelled) else { return }
      guard process.isRunning else { return }
      process.terminate()
    }
  }

  func execute(
    _ command: String,
    arguments: [String: Any],
    protectedInput: String?,
    capabilitySchemaVersion: Int
  ) async throws -> Data {
    guard let root else { throw BridgeFailure.missingRoot }
    let resolvedRoot = root.standardizedFileURL.resolvingSymlinksInPath()
    let bridge = resolvedRoot.appendingPathComponent("src/desktop-command-bridge.mjs")
    let bridgePath = bridge.standardizedFileURL.resolvingSymlinksInPath().path
    guard bridgePath == bridge.path, bridgePath.hasPrefix(resolvedRoot.path + "/"), FileManager.default.fileExists(atPath: bridgePath) else {
      throw BridgeFailure.missingBridge
    }
    guard let node = Self.validatedNodeBinary(root: resolvedRoot) else { throw BridgeFailure.missingNode }

    var request: [String: Any] = [
      "args": arguments,
      "capabilitySchemaVersion": capabilitySchemaVersion,
    ]
    if let protectedInput { request["protectedInput"] = protectedInput }
    var input = try JSONSerialization.data(withJSONObject: request, options: [])
    request.removeValue(forKey: "protectedInput")

    let process = Process()
    let stdin = Pipe()
    let stdout = Pipe()
    let stderr = Pipe()
    process.executableURL = node
    process.arguments = [bridge.path, command]
    process.currentDirectoryURL = resolvedRoot
    process.standardInput = stdin
    process.standardOutput = stdout
    process.standardError = stderr
    let completion = ProcessCompletion()
    process.terminationHandler = { child in
      completion.succeed(child.terminationStatus)
    }
    do {
      try process.run()
    } catch {
      Self.zeroize(&input)
      throw RouterError("The Router command could not start.")
    }

    let stopProcess = { if process.isRunning { process.terminate() } }
    let stdoutReader = Task.detached(priority: .userInitiated) {
      Self.boundedRead(stdout.fileHandleForReading, limit: Self.outputLimit, terminate: stopProcess)
    }
    let stderrReader = Task.detached(priority: .userInitiated) {
      Self.boundedRead(stderr.fileHandleForReading, limit: Self.outputLimit, terminate: stopProcess)
    }
    stdin.fileHandleForWriting.write(input)
    stdin.fileHandleForWriting.closeFile()
    Self.zeroize(&input)

    // Timeout owns termination itself. It does not wait in a task group for a
    // child task whose continuation might be cancelled only after the process
    // exits; this keeps TERM/grace/KILL bounded even for a SIGTERM-resistant
    // helper. ProcessCompletion makes the normal-exit and timeout paths
    // single-completion by construction.
    let timeoutTask = Task {
      try? await Task.sleep(for: Self.commandTimeout)
      guard !Task.isCancelled, !completion.isCompleted else { return }
      if !process.isRunning {
        completion.succeed(process.terminationStatus)
        return
      }
      guard completion.fail(.timedOut) else { return }
      await Self.terminateProcess(process)
    }

    let status: Int32
    do {
      status = try await Self.waitForProcess(process, completion: completion)
    } catch {
      if case BridgeFailure.timedOut = error {
        // The timeout task performs the bounded grace period and escalation;
        // wait for it before draining pipes so a resistant child cannot leave
        // the collectors blocked forever.
        _ = await timeoutTask.value
      } else if case BridgeFailure.cancelled = error {
        timeoutTask.cancel()
        await Self.terminateProcess(process)
        _ = await timeoutTask.value
      } else {
        timeoutTask.cancel()
        await Self.terminateProcess(process)
        _ = await timeoutTask.value
      }
      _ = await stdoutReader.value
      _ = await stderrReader.value
      throw (error as? BridgeFailure) ?? BridgeFailure.timedOut
    }

    timeoutTask.cancel()
    _ = await timeoutTask.value
    let output = await stdoutReader.value
    _ = await stderrReader.value
    if output.count >= Self.outputLimit {
      throw BridgeFailure.outputLimit
    }
    // A canonical error envelope remains authoritative even when the helper
    // exits non-zero (for example, malformed stdin). Never replace it with
    // stderr text, which may contain provider-owned data.
    if Self.isEnvelope(output) { return output }
    if status != 0 { throw BridgeFailure.invalidOutput }
    return output
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

struct RouterActivitySnapshot: Decodable {
  let state: RouterActivityState
  let provider: String?
  let model: String?
  let sessionName: String?
  let activeCount: Int
  let active: [RouterActiveRequest]

  init(from decoder: Decoder) throws {
    let values = try decoder.container(keyedBy: CodingKeys.self)
    state = try values.decodeIfPresent(RouterActivityState.self, forKey: .state) ?? .idle
    provider = try values.decodeIfPresent(String.self, forKey: .provider)
    model = try values.decodeIfPresent(String.self, forKey: .model)
    sessionName = try values.decodeIfPresent(String.self, forKey: .sessionName)
    active = try values.decodeIfPresent([RouterActiveRequest].self, forKey: .active) ?? []
    activeCount = try values.decodeIfPresent(Int.self, forKey: .activeCount) ?? active.count
  }

  private enum CodingKeys: String, CodingKey { case state, provider, model, sessionName, activeCount, active }
}

struct RouterSnapshot: Decodable {
  let targets: [String: RouterTarget]
  let presence: RouterPresence?
  let activity: RouterActivitySnapshot?
  let serviceRunning: Bool?
  let capabilities: CapabilitySnapshotV1?
  let accountUsage: CodexAccountUsage?
  let providerUsage: ProviderUsageSnapshot?

  static let empty = RouterSnapshot(targets: [:], presence: nil, activity: nil, serviceRunning: nil, capabilities: nil, accountUsage: nil, providerUsage: nil)

  init(targets: [String: RouterTarget], presence: RouterPresence?, activity: RouterActivitySnapshot?, serviceRunning: Bool?, capabilities: CapabilitySnapshotV1?, accountUsage: CodexAccountUsage?, providerUsage: ProviderUsageSnapshot?) {
    self.targets = targets
    self.presence = presence
    self.activity = activity
    self.serviceRunning = serviceRunning
    self.capabilities = capabilities
    self.accountUsage = accountUsage
    self.providerUsage = providerUsage
  }

  init(from decoder: Decoder) throws {
    let values = try decoder.container(keyedBy: CodingKeys.self)
    targets = (try? values.decode([String: RouterTarget].self, forKey: .targets)) ?? [:]
    presence = try? values.decode(RouterPresence.self, forKey: .presence)
    activity = try? values.decode(RouterActivitySnapshot.self, forKey: .activity)
    if let direct = try? values.decode(Bool.self, forKey: .serviceRunning) {
      serviceRunning = direct
    } else if let service = try? values.nestedContainer(keyedBy: ServiceCodingKeys.self, forKey: .service),
      let running = try? service.decode(Bool.self, forKey: .running) {
      serviceRunning = running
    } else {
      serviceRunning = nil
    }
    capabilities = try? values.decode(CapabilitySnapshotV1.self, forKey: .capabilities)
    accountUsage = try? values.decode(CodexAccountUsage.self, forKey: .accountUsage)
    providerUsage = try? values.decode(ProviderUsageSnapshot.self, forKey: .providerUsage)
  }

  private enum CodingKeys: String, CodingKey { case targets, presence, activity, serviceRunning, service, capabilities, accountUsage, providerUsage }
  private enum ServiceCodingKeys: String, CodingKey { case running, active, isRunning }
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

  static func fromNode(_ value: String?) -> TrayPresenceMode? {
    switch value {
    case "always": return .always
    case "follow-codex", "follow-clients": return .followCodex
    default: return nil
    }
  }
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

  // `stoppedByTray` is ownership, not an observation. A service that another
  // process stopped must not be started on tray quit as if this tray had
  // borrowed it, while a follow-mode stop initiated here must be restored.
  // The in-flight states are also the duplicate-dispatch guard for the 5s
  // host poll: a second observation queues intent instead of spawning a second
  // service command.
  private enum ServiceIntent: Equatable { case unknown, running, startingByTray, stoppingByTray, stoppedByTray }

  private enum ServiceAction: Equatable {
    case start
    case stop
    case restart

    var isStarting: Bool { self != .stop }
    var commandName: String {
      switch self {
      case .start: return "lifecycle.start"
      case .stop: return "lifecycle.stop"
      case .restart: return "lifecycle.restart"
      }
    }
    var intent: ServiceIntent { isStarting ? .startingByTray : .stoppingByTray }
  }

  @Published private(set) var snapshot = RouterSnapshot.empty
  @Published private(set) var capabilitySnapshot = CapabilitySnapshotV1.empty
  @Published private(set) var healthVersion = HealthVersionEnvelope.empty
  @Published private(set) var commandResult: CapabilityCommandResult?
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
  private let hostAppAbsenceGrace = Duration.seconds(30)
  private let hostAppRecheckInterval = Duration.seconds(5)
  private let terminationRestoreTimeout = Duration.seconds(10)
  private var pendingServiceStop: Task<Void, Never>?
  private var bridge = DesktopCommandBridge()
  private var polling = false
  private var statusPollingTask: Task<Void, Never>?
  private var activityPollingTask: Task<Void, Never>?
  private var accountUsagePollingTask: Task<Void, Never>?
  private var providerUsagePollingTask: Task<Void, Never>?
  private var hostObservationTask: Task<Void, Never>?
  private var surfaceVisibilityTask: Task<Void, Never>?
  private var workspaceObservers: [NSObjectProtocol] = []
  private var serviceIntent: ServiceIntent = .unknown
  private var serviceOperationTask: Task<Bool, Never>?
  private var serviceOperationAction: ServiceAction?
  private var serviceRequestedAction: ServiceAction?
  private var serviceRestoreOwnership = false
  private let hostAppBundleIDs = ["com.openai.codex", "com.openai.chat"]
  nonisolated static let hostProcessNames = ["codex"]

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
    // Presence is owned by Node and filled by the first lifecycle.status
    // refresh; a new launch must not resurrect a stale local preference.
    presenceMode = .always
  }

  // NSWorkspace sees bundled desktop clients, while a terminal Codex process
  // has no bundle. Keep the process scan pure and nonisolated so the host
  // observation tests can exercise it without constructing the tray.
  nonisolated static func anyProcessRunning(named names: [String]) -> Bool {
    var request: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_ALL, 0]
    var byteCount = 0
    guard sysctl(&request, UInt32(request.count), nil, &byteCount, nil, 0) == 0, byteCount > 0 else { return false }
    let stride = MemoryLayout<kinfo_proc>.stride
    var entries = [kinfo_proc](repeating: kinfo_proc(), count: byteCount / stride + 32)
    byteCount = entries.count * stride
    let read = entries.withUnsafeMutableBytes { buffer -> Int32 in
      sysctl(&request, UInt32(request.count), buffer.baseAddress, &byteCount, nil, 0)
    }
    guard read == 0 else { return false }
    var parentOf: [pid_t: pid_t] = [:]
    var matches: [pid_t] = []
    for index in 0..<min(byteCount / stride, entries.count) {
      let process = entries[index].kp_proc
      let pid = process.p_pid
      parentOf[pid] = entries[index].kp_eproc.e_ppid
      let name = withUnsafeBytes(of: process.p_comm) { raw -> String in
        var length = 0
        while length < raw.count, raw[length] != 0 { length += 1 }
        return String(decoding: raw[0..<length], as: UTF8.self)
      }
      if names.contains(where: { $0.compare(name, options: .caseInsensitive) == .orderedSame }) {
        matches.append(pid)
      }
    }
    let own = getpid()
    return matches.contains { !isDescendant($0, of: own, parentOf: parentOf) }
  }

  nonisolated static func isDescendant(_ pid: pid_t, of ancestor: pid_t, parentOf: [pid_t: pid_t]) -> Bool {
    var current = pid
    for _ in 0..<64 {
      if current == ancestor { return true }
      guard let parent = parentOf[current], parent != 0, parent != current else { return false }
      current = parent
    }
    return false
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

  var shouldRestoreServiceOnTermination: Bool {
    effectivePresenceMode == .followCodex && serviceRestoreOwnership && serviceIntent != .running
  }

  func prepareForTermination() {
    stopPolling()
  }

  // AppKit gives the delegate a synchronous termination decision. Keep the
  // restore operation in the same serialized service task as host presence,
  // race it against a bounded deadline, and preserve ownership on failure so
  // a later termination request can retry. The failure policy intentionally
  // keeps the tray open: silently quitting with a stopped Router violates the
  // follow-mode contract and leaves the user no way to retry from this UI.
  func restoreServiceBeforeTermination() async -> Bool {
    guard shouldRestoreServiceOnTermination else {
      prepareForTermination()
      return true
    }
    prepareForTermination()
    let operation = enqueueServiceAction(.start)
    let timeout = terminationRestoreTimeout
    return await withTaskGroup(of: Bool.self) { group in
      group.addTask { await operation.value }
      group.addTask {
        do {
          try await Task.sleep(for: timeout)
          return false
        } catch {
          return true
        }
      }
      let result = await group.next() ?? false
      group.cancelAll()
      if !result { operation.cancel() }
      return result
    }
  }

  func startHostAppObservation() {
    let center = NSWorkspace.shared.notificationCenter
    if workspaceObservers.isEmpty {
      for name in [NSWorkspace.didLaunchApplicationNotification, NSWorkspace.didTerminateApplicationNotification] {
        workspaceObservers.append(center.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
          Task { @MainActor [weak self] in await self?.refreshHostAppRunning() }
        })
      }
    }
    hostObservationTask?.cancel()
    hostObservationTask = Task { @MainActor [weak self] in
      while !Task.isCancelled {
        guard let self else { return }
        await self.refreshHostAppRunning()
        try? await Task.sleep(for: self.hostAppRecheckInterval)
      }
    }
  }

  func stopPolling() {
    polling = false
    statusPollingTask?.cancel()
    activityPollingTask?.cancel()
    accountUsagePollingTask?.cancel()
    providerUsagePollingTask?.cancel()
    hostObservationTask?.cancel()
    surfaceVisibilityTask?.cancel()
    pendingServiceStop?.cancel()
    statusPollingTask = nil
    activityPollingTask = nil
    accountUsagePollingTask = nil
    providerUsagePollingTask = nil
    hostObservationTask = nil
    surfaceVisibilityTask = nil
    pendingServiceStop = nil
    let center = NSWorkspace.shared.notificationCenter
    for observer in workspaceObservers { center.removeObserver(observer) }
    workspaceObservers.removeAll()
    clearCommandResult()
  }

  private var effectivePresenceMode: TrayPresenceMode {
    routerPinsServiceOn ? .always : presenceMode
  }

  private func refreshSurfacesVisible() {
    let next = effectivePresenceMode == .always || hostAppRunning
    guard surfacesVisible != next else { return }
    surfaceVisibilityTask?.cancel()
    surfaceVisibilityTask = Task { @MainActor [weak self] in
      try? await Task.sleep(nanoseconds: 1_000_000_000)
      guard let self, !Task.isCancelled, surfacesVisible != next else { return }
      surfacesVisible = next
    }
  }

  private func hostAppRunningNow() -> Bool {
    if hostAppBundleIDs.contains(where: { identifier in
      NSRunningApplication.runningApplications(withBundleIdentifier: identifier).contains { !$0.isTerminated }
    }) { return true }
    return Self.anyProcessRunning(named: Self.hostProcessNames)
  }

  private func refreshHostAppRunning() async {
    let processRunning = hostAppRunningNow()
    if let value = try? await executeCanonicalCommand("presence.status"), case .object(let object) = value {
      let published = object["harnessPublished"].flatMap { value -> Bool? in if case .bool(let flag) = value { return flag }; return nil } ?? false
      let terminal = object["terminalCodex"].flatMap { value -> Bool? in if case .bool(let flag) = value { return flag }; return nil } ?? false
      routerPinsServiceOn = published || terminal
      if case let .some(.string(effective)) = object["effectiveMode"] {
        presenceMode = TrayPresenceMode.fromNode(effective) ?? presenceMode
      }
    }
    hostAppRunning = processRunning
    if effectivePresenceMode == .followCodex, processRunning, serviceRestoreOwnership, serviceIntent != .running {
      // `enqueueServiceAction` changes the intent before creating the Task,
      // so a notification plus the next 5s poll can observe only one start.
      _ = enqueueServiceAction(.start)
    }
    refreshSurfacesVisible()
    if effectivePresenceMode == .followCodex, !hostAppRunning { schedulePresenceStop() }
  }

  private func schedulePresenceStop() {
    guard pendingServiceStop == nil else { return }
    pendingServiceStop = Task { @MainActor [weak self] in
      guard let self else { return }
      try? await Task.sleep(for: hostAppAbsenceGrace)
      await self.refreshHostAppRunning()
      guard !Task.isCancelled, effectivePresenceMode == .followCodex, !hostAppRunning else {
        pendingServiceStop = nil
        return
      }
      while !Task.isCancelled && (activeRequestCount != 0 || activityState != .idle) {
        try? await Task.sleep(for: hostAppRecheckInterval)
        await self.refreshHostAppRunning()
        guard !hostAppRunning else { pendingServiceStop = nil; return }
      }
      guard !Task.isCancelled, activeRequestCount == 0 && activityState == .idle, !hostAppRunning else {
        pendingServiceStop = nil
        return
      }
      await runServiceCommand("stop")
      pendingServiceStop = nil
    }
  }

  private func enqueueServiceAction(_ action: ServiceAction) -> Task<Bool, Never> {
    if let operation = serviceOperationTask {
      if serviceOperationAction == action || serviceRequestedAction == action { return operation }
      // A host can return while the delayed stop is still unwinding. Record the
      // newer user/host intent and let the one worker perform it next.
      serviceRequestedAction = action
      serviceIntent = action.intent
      if action == .start { serviceRestoreOwnership = true }
      return operation
    }
    if action == .start, serviceIntent == .running { return Task { true } }
    if action == .stop, serviceIntent == .stoppedByTray { return Task { true } }

    // This transition is deliberately before Task construction. Swift's
    // unstructured Task may run immediately on the main actor; setting it here
    // makes the in-flight state atomic with the enqueue operation itself.
    if action == .stop { serviceRestoreOwnership = true }
    if action.isStarting, serviceIntent == .stoppedByTray { serviceRestoreOwnership = true }
    serviceIntent = action.isStarting ? .startingByTray : .stoppingByTray
    serviceOperationAction = action
    serviceRequestedAction = nil
    let operation = Task { @MainActor [weak self] in
      guard let self else { return false }
      var current = action
      var result = true
      while true {
        result = await self.performServiceAction(current)
        guard let next = self.serviceRequestedAction else { break }
        self.serviceRequestedAction = nil
        current = next
        self.serviceOperationAction = current
        self.serviceIntent = current.intent
      }
      self.serviceOperationAction = nil
      self.serviceOperationTask = nil
      return result
    }
    serviceOperationTask = operation
    return operation
  }

  private func performServiceAction(_ action: ServiceAction) async -> Bool {
    do {
      _ = try await executeCanonicalCommand(action.commandName, recordResult: true)
      if !action.isStarting {
        serviceIntent = .stoppedByTray
        serviceRestoreOwnership = true
      } else {
        serviceIntent = .running
        serviceRestoreOwnership = false
      }
      return true
    } catch {
      if action.isStarting, serviceRestoreOwnership {
        serviceIntent = .stoppedByTray
      } else {
        serviceIntent = .unknown
        // The stop was still tray-owned even though its command failed. Keep
        // the ownership bit so host reappearance and termination can issue an
        // idempotent start; a later observed running snapshot clears it.
      }
      message = error.localizedDescription
      return false
    }
  }

  private func runServiceCommand(_ action: String) async {
    let requested: ServiceAction = action == "stop" ? .stop : .start
    _ = await enqueueServiceAction(requested).value
  }

  func setPresenceMode(_ mode: TrayPresenceMode) {
    Task { @MainActor [weak self] in
      guard let self else { return }
      do {
        _ = try await executeCanonicalCommand("presence.mode", arguments: ["mode": mode.controlValue])
        _ = await refresh()
      } catch {
        message = error.localizedDescription
        // The Node snapshot remains authoritative when the mutation fails.
      }
      refreshSurfacesVisible()
    }
  }

  func startPolling() async {
    guard !polling else { return }
    polling = true
    _ = await refresh()
    statusPollingTask?.cancel()
    statusPollingTask = Task { @MainActor [weak self] in
      var failures = 0
      while !Task.isCancelled {
        guard let self else { return }
        let healthy = await self.refresh()
        failures = healthy ? 0 : min(failures + 1, 4)
        let seconds = healthy ? 30 : min(30 * (1 << failures), 300)
        try? await Task.sleep(for: .seconds(seconds))
      }
    }
  }

  func startActivityPolling() async {
    guard activityPollingTask == nil else { return }
    activityPollingTask = Task { @MainActor [weak self] in
      while !Task.isCancelled {
        guard let self else { return }
        await self.refreshActivity()
        try? await Task.sleep(for: .seconds(5))
      }
    }
  }

  func startAccountUsagePolling() async {
    guard accountUsagePollingTask == nil else { return }
    accountUsagePollingTask = Task { @MainActor [weak self] in
      while !Task.isCancelled {
        guard let self else { return }
        await self.refreshAccountUsage()
        try? await Task.sleep(for: .seconds(30))
      }
    }
  }

  func startProviderPolling() async {
    guard providerUsagePollingTask == nil else { return }
    providerUsagePollingTask = Task { @MainActor [weak self] in
      while !Task.isCancelled {
        guard let self else { return }
        await self.refreshProviderUsage()
        try? await Task.sleep(for: .seconds(30))
      }
    }
  }

  private func refreshActivity() async {
    do {
      guard let value = try await executeCanonicalCommand("lifecycle.status"), case .object(let object) = value else { return }
      guard case let .some(.object(activityValue)) = object["activity"] else { return }
      let data = try JSONEncoder().encode(JSONValue.object(activityValue))
      let activity = try JSONDecoder().decode(RouterActivitySnapshot.self, from: data)
      applyActivity(activity)
    } catch {
      // Status polling is best-effort; the main snapshot owns the user-facing error.
    }
  }

  private func applyActivity(_ activity: RouterActivitySnapshot) {
    activityState = activity.state
    activeRequests = activity.active
    activeRequestCount = activity.activeCount
    activeModel = activity.model
    activitySessionName = activity.sessionName
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

  @discardableResult
  func refresh() async -> Bool {
    isRefreshing = true
    defer { isRefreshing = false }
    clearCapabilityState()
    do {
      guard let value = try await executeCanonicalCommand("lifecycle.status") else { throw RouterError("The Router returned no status.") }
      let data = try JSONEncoder().encode(value)
      healthVersion = (try? JSONDecoder().decode(HealthVersionEnvelope.self, from: data)) ?? HealthVersionEnvelope.empty
      if let reported = healthVersion.capabilitySchemaVersion, reported != 1 {
        capabilitySnapshot = CapabilitySnapshotV1(
          capabilitySchemaVersion: reported,
          compatibility: CapabilityCompatibility(readOnly: true, reason: "unknown_major_version"),
          mutationsEnabled: false,
          commands: [],
          capabilities: []
        )
      }
      let decoded = try JSONDecoder().decode(RouterSnapshot.self, from: data)
      snapshot = decoded
      if let activity = decoded.activity { applyActivity(activity) }
      if decoded.serviceRunning == true {
        serviceIntent = .running
        serviceRestoreOwnership = false
      }
      if let presence = decoded.presence {
        presenceMode = TrayPresenceMode.fromNode(presence.effectiveMode) ?? TrayPresenceMode.fromNode(presence.mode) ?? .always
        routerPinsServiceOn = presence.harnessPublished || presence.terminalCodex
      }
      if let capabilities = decoded.capabilities {
        capabilitySnapshot = capabilities
        healthVersion = HealthVersionEnvelope(
          health: "available",
          version: "schema \(capabilities.capabilitySchemaVersion)",
          capabilitySchemaVersion: capabilities.capabilitySchemaVersion,
          compatibilityReason: capabilities.compatibility.reason
        )
      }
      accountUsage = decoded.accountUsage ?? accountUsage
      providerUsage = decoded.providerUsage ?? providerUsage
      lastUpdated = Date()
      message = nil
      return true
    } catch {
      message = error.localizedDescription
      return false
    }
  }

  private func clearCapabilityState() {
    snapshot = .empty
    capabilitySnapshot = .empty
    healthVersion = .empty
    commandResult = nil
    presenceMode = .always
    routerPinsServiceOn = false
    activeRequests = []
    activeRequestCount = 0
    activeModel = nil
    activitySessionName = nil
    activityState = .idle
  }

  func clearCommandResult() { commandResult = nil }

  func executeCanonicalCommand(
    _ command: String,
    arguments: [String: Any] = [:],
    protectedInput: String? = nil,
    recordResult: Bool = false
  ) async throws -> JSONValue? {
    if command != "lifecycle.status" && !capabilitySnapshot.isCompatible {
      throw RouterError(capabilitySnapshot.incompatibilityText)
    }
    let data = try await bridge.execute(
      command,
      arguments: arguments,
      protectedInput: protectedInput,
      capabilitySchemaVersion: capabilitySnapshot.capabilitySchemaVersion
    )
    let envelope = try JSONDecoder().decode(DesktopCommandEnvelope<JSONValue>.self, from: data)
    guard envelope.ok else {
      guard let error = envelope.error else { throw RouterError("The Router command failed.") }
      if recordResult {
        commandResult = CapabilityCommandResult(
          command: command,
          resultKind: capabilitySnapshot.command(command)?.resultKind ?? "json",
          value: nil,
          error: error
        )
      }
      let code = error.code
      throw RouterError("\(code): \(error.message)")
    }
    if recordResult {
      commandResult = CapabilityCommandResult(
        command: command,
        resultKind: capabilitySnapshot.command(command)?.resultKind ?? "json",
        value: envelope.value,
        error: nil
      )
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
    var result: CapabilityCommandResult?
    do {
      let serviceAction: ServiceAction? = switch command.name {
      case "lifecycle.start": .start
      case "lifecycle.stop": .stop
      case "lifecycle.restart": .restart
      default: nil
      }
      if let serviceAction {
        let succeeded = await enqueueServiceAction(serviceAction).value
        guard succeeded else { throw RouterError(message ?? "The Router service command failed.") }
      } else {
        _ = try await executeCanonicalCommand(command.name, arguments: arguments, protectedInput: protectedInput, recordResult: true)
      }
      result = commandResult
      message = "\(command.name) applied."
      if command.name == "credential.set" { await refreshProviderUsage() }
      _ = await refresh()
      commandResult = result
    } catch {
      result = commandResult
      message = error.localizedDescription
      _ = await refresh()
      commandResult = result
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
            if store.commandResult != nil {
              CapabilityResultView(store: store)
            }
          }
          .padding(14)
        }
      } else {
        IncompatibleCapabilityView(snapshot: store.capabilitySnapshot, healthVersion: store.healthVersion)
      }
    }
    .frame(width: 370, height: 590)
    .background(.regularMaterial)
    .onDisappear { store.clearCommandResult() }
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
  let healthVersion: HealthVersionEnvelope

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      Image(systemName: "exclamationmark.triangle").foregroundStyle(routerYellow)
      Text(routerLocalized("Router capability update required")).font(.headline)
      Text(snapshot.incompatibilityText).font(.subheadline).foregroundStyle(routerMuted)
      Text(routerFormat("Health: %@", healthVersion.health)).font(.caption.monospaced()).foregroundStyle(routerMuted)
      Text(routerFormat("Version: %@", healthVersion.version)).font(.caption.monospaced()).foregroundStyle(routerMuted)
      if let schema = healthVersion.capabilitySchemaVersion {
        Text(routerFormat("Capability schema %d", schema)).font(.caption.monospaced()).foregroundStyle(routerMuted)
      }
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
        Text(routerLocalized(capability.localizationKey)).font(.subheadline.weight(.semibold))
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
        Text(routerLocalized(command.ui.localizationKey)).font(.caption.weight(.medium))
        Spacer()
        if command.hasQuotaWarning { Text(routerLocalized("Quota warning")).font(.caption2).foregroundStyle(routerYellow) }
      }
      ForEach(command.arguments.properties.keys.sorted(), id: \.self) { name in
        argumentField(name)
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

  @ViewBuilder
  private func argumentField(_ name: String) -> some View {
    let presentation = command.ui.fields[name]
    if let presentation, !presentation.enumValues.isEmpty {
      Picker(routerLocalized(presentation.localizationKey), selection: Binding(
        get: { fields[name, default: ""] },
        set: { fields[name] = $0 }
      )) {
        ForEach(presentation.enumValues, id: \.self) { value in
          Text(value).tag(value)
        }
      }
      .pickerStyle(.menu)
    } else if presentation?.type.contains("boolean") == true {
      Toggle(routerLocalized(presentation?.localizationKey ?? "field.value"), isOn: Binding(
        get: { fields[name, default: "true"] == "true" },
        set: { fields[name] = $0 ? "true" : "false" }
      ))
    } else {
      TextField(routerLocalized(presentation?.localizationKey ?? "field.value"), text: Binding(
        get: { fields[name, default: ""] },
        set: { fields[name] = $0 }
      ))
      .textFieldStyle(.roundedBorder)
      .font(.caption)
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

private struct CapabilityResultView: View {
  @ObservedObject var store: RouterStore

  var body: some View {
    if let result = store.commandResult {
      VStack(alignment: .leading, spacing: 7) {
        HStack {
          Text(result.isError ? routerLocalized("Command failed") : routerLocalized("Command result"))
            .font(.subheadline.weight(.semibold))
          Spacer()
          Button(routerLocalized("Clear")) { store.clearCommandResult() }
            .buttonStyle(.borderless)
            .accessibilityLabel(routerLocalized("Clear command result"))
        }
        Text(result.command).font(.caption.monospaced()).foregroundStyle(routerMuted)
        if let error = result.error {
          Text("\(error.code): \(error.message)")
            .font(.caption)
            .foregroundStyle(routerRed)
            .textSelection(.enabled)
            .accessibilityLabel(routerLocalized("Error details"))
        } else if let text = result.text {
          Text(text)
            .font(.caption.monospaced())
            .textSelection(.enabled)
            .frame(maxWidth: .infinity, alignment: .leading)
          if result.resultKind == "protected-text" {
            Button(routerLocalized("Copy protected result")) {
              NSPasteboard.general.clearContents()
              NSPasteboard.general.setString(text, forType: .string)
            }
            .buttonStyle(.borderless)
            .accessibilityLabel(routerLocalized("Copy protected result"))
          }
        }
      }
      .padding(10)
      .background(Color.primary.opacity(0.05), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
    }
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

enum MenuBarStatusItemConfiguration {
  // Give the AppKit item a private identity instead of inheriting the old
  // SwiftUI Item-0 slot that the user removed from ControlCenter.
  static let autosaveName: String? = "ModelRouterTray"
  static let defaultLength: CGFloat = 24
  static let fallbackTitle = "MR"
  static let overlayWidth: CGFloat = 32
  static let overlayHeight: CGFloat = 24
  static let fallbackImageName = "AppIcon"
  static let visibilityRecoveryDelay: TimeInterval = 1
}

@MainActor
private final class MenuBarOverlayController: NSObject {
  let panel: NSPanel
  let button: NSButton
  var onClick: (() -> Void)?

  init(store: RouterStore) {
    panel = NSPanel(
      contentRect: NSRect(x: 0, y: 0, width: MenuBarStatusItemConfiguration.overlayWidth, height: MenuBarStatusItemConfiguration.overlayHeight),
      styleMask: [.borderless, .nonactivatingPanel],
      backing: .buffered,
      defer: false
    )
    button = NSButton(frame: NSRect(x: 0, y: 0, width: MenuBarStatusItemConfiguration.overlayWidth, height: MenuBarStatusItemConfiguration.overlayHeight))
    super.init()
    panel.level = .screenSaver
    panel.isOpaque = false
    panel.backgroundColor = .clear
    panel.hasShadow = false
    panel.hidesOnDeactivate = false
    panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
    panel.ignoresMouseEvents = false
    button.isBordered = false
    button.imagePosition = .noImage
    button.wantsLayer = true
    button.layer?.backgroundColor = NSColor(calibratedRed: 0.03, green: 0.08, blue: 0.16, alpha: 0.96).cgColor
    button.layer?.cornerRadius = 6
    button.layer?.masksToBounds = true
    button.image = nil
    button.attributedTitle = NSAttributedString(
      string: MenuBarStatusItemConfiguration.fallbackTitle,
      attributes: [
        .foregroundColor: NSColor.white,
        .font: NSFont.systemFont(ofSize: 11, weight: .bold),
      ]
    )
    button.toolTip = routerLocalized("Model Router")
    button.target = self
    button.action = #selector(clicked(_:))
    panel.contentView = button
  }

  func show() {
    guard let screen = NSScreen.main ?? NSScreen.screens.first else { return }
    let frame = screen.frame
    let x = max(frame.minX, frame.maxX - 270)
    let y = frame.maxY - MenuBarStatusItemConfiguration.overlayHeight
    panel.setFrame(NSRect(x: x, y: y, width: MenuBarStatusItemConfiguration.overlayWidth, height: MenuBarStatusItemConfiguration.overlayHeight), display: true)
    panel.orderFrontRegardless()
  }

  @objc private func clicked(_ sender: Any?) {
    onClick?()
  }
}

@main
struct ModelRouterTrayApp: App {
  @NSApplicationDelegateAdaptor private var appDelegate: AppDelegate
  @ObservedObject private var store = RouterStore.shared

  var body: some Scene {
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
  private var statusItem: NSStatusItem?
  private var statusPopover: NSPopover?
  private var menuBarOverlay: MenuBarOverlayController?
  private var statusButtonObservation: AnyCancellable?
  private var surfaceVisibility: AnyCancellable?
  private var terminationRestoreTask: Task<Void, Never>?

  func applicationDidFinishLaunching(_ notification: Notification) {
    if CommandLine.arguments.contains("--codex-router-capability-probe") {
      Task { @MainActor in
        do {
          let result = try await DesktopCommandBridge().execute(
            "lifecycle.status",
            arguments: [:],
            protectedInput: nil,
            capabilitySchemaVersion: 1
          )
          guard let lifecycle = try JSONSerialization.jsonObject(with: result) as? [String: Any],
            lifecycle["ok"] as? Bool == true,
            let value = lifecycle["value"] as? [String: Any],
            let capabilityManifest = value["capabilities"]
          else { throw RouterError("The Router capability probe returned no manifest.") }
          let probeEnvelope: [String: Any] = [
            "ok": true,
            "value": ["capabilityManifest": capabilityManifest],
          ]
          FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: probeEnvelope))
          FileHandle.standardOutput.write(Data("\n".utf8))
          exit(0)
        } catch {
          FileHandle.standardError.write(Data("capability probe failed\n".utf8))
          exit(1)
        }
      }
      return
    }
    NSApp.setActivationPolicy(.accessory)
    installStatusItem()
    islandController = IslandWindowController(store: store)
    desktopPanelController = DesktopPanelWindowController(store: store)
    statusButtonObservation = store.objectWillChange.sink { [weak self] in
      Task { @MainActor [weak self] in self?.refreshStatusItem() }
    }
    menuBarOverlay = MenuBarOverlayController(store: store)
    menuBarOverlay?.onClick = { [weak self] in self?.toggleStatusPopover(nil) }
    menuBarOverlay?.show()
    surfaceVisibility = store.$surfacesVisible.combineLatest(store.$islandMode).sink { [weak self] visible, mode in
      Task { @MainActor [weak self] in
        self?.statusItem?.isVisible = visible
        if visible {
          self?.menuBarOverlay?.show()
        } else {
          self?.menuBarOverlay?.panel.orderOut(nil)
        }
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

  private func installStatusItem() {
    let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    // Do not reuse the system's Item-0 slot, which is exactly what the user
    // had removed from ControlCenter.
    item.autosaveName = MenuBarStatusItemConfiguration.autosaveName
    item.isVisible = false
    statusItem = item
    let menu = NSMenu()
    menu.autoenablesItems = false
    let openItem = NSMenuItem(
      title: routerLocalized("Open Model Router"),
      action: #selector(toggleStatusPopover(_:)),
      keyEquivalent: ""
    )
    openItem.target = self
    menu.addItem(openItem)
    menu.addItem(.separator())
    let quitItem = NSMenuItem(
      title: routerLocalized("Quit"),
      action: #selector(terminateFromStatusMenu(_:)),
      keyEquivalent: "q"
    )
    quitItem.target = self
    menu.addItem(quitItem)
    item.menu = menu
    let popover = NSPopover()
    popover.behavior = .transient
    popover.animates = true
    popover.contentSize = NSSize(width: 370, height: 590)
    popover.contentViewController = NSHostingController(rootView: CapabilityTrayView(store: store))
    statusPopover = popover
    if let button = item.button {
      button.target = self
      button.action = #selector(toggleStatusPopover(_:))
      button.imagePosition = .imageOnly
      button.imageScaling = .scaleProportionallyDown
      button.title = MenuBarStatusItemConfiguration.fallbackTitle
      button.setAccessibilityLabel(routerLocalized("Model Router"))
      button.toolTip = routerLocalized("Model Router")
    }
    refreshStatusItem()
    NSLog("Model Router status item installed: visible=%@ button=%@", item.isVisible.description, String(describing: item.button))
    DispatchQueue.main.asyncAfter(deadline: .now() + MenuBarStatusItemConfiguration.visibilityRecoveryDelay) { [weak self, weak item] in
      guard let self, let item else { return }
      item.isVisible = false
      self.refreshStatusItem()
    }
  }

  private func refreshStatusItem() {
    guard let button = statusItem?.button else { return }
    statusItem?.isVisible = false
    let symbolName = store.menuBarPresetIcon.isEmpty ? "cpu" : store.menuBarPresetIcon
    let image = NSImage(systemSymbolName: symbolName, accessibilityDescription: routerLocalized("Model Router"))
      ?? NSImage(systemSymbolName: "cpu", accessibilityDescription: routerLocalized("Model Router"))
      ?? NSImage(named: MenuBarStatusItemConfiguration.fallbackImageName)
    image?.isTemplate = true
    button.image = image
    button.toolTip = RouterStore.menuBarTooltip(
      provider: store.selectedUsageProvider.shortName,
      state: store.activityState.label,
      usage: nil
    )
  }

  @objc private func toggleStatusPopover(_ sender: Any?) {
    guard let popover = statusPopover else { return }
    let button = menuBarOverlay?.button ?? statusItem?.button
    guard let button else { return }
    if popover.isShown {
      popover.performClose(sender)
    } else {
      NSApp.activate(ignoringOtherApps: true)
      popover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)
    }
  }

  @objc private func terminateFromStatusMenu(_ sender: Any?) {
    NSApp.terminate(sender)
  }

  func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows: Bool) -> Bool {
    store.revealForUserLaunch()
    return true
  }

  func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
    guard store.shouldRestoreServiceOnTermination else {
      store.prepareForTermination()
      return .terminateNow
    }
    guard terminationRestoreTask == nil else { return .terminateLater }
    terminationRestoreTask = Task { @MainActor [weak self] in
      guard let self else { return }
      let restored = await self.store.restoreServiceBeforeTermination()
      self.terminationRestoreTask = nil
      // Failure keeps the app open so the user can retry; success is the only
      // path that allows the app to exit after restoring the Router.
      NSApp.reply(toApplicationShouldTerminate: restored)
    }
    return .terminateLater
  }

  func applicationWillTerminate(_ notification: Notification) {
    // AppKit has already received the termination reply. No asynchronous work
    // may be launched from this final callback.
    if let statusItem { NSStatusBar.system.removeStatusItem(statusItem) }
    statusItem = nil
    statusPopover = nil
    menuBarOverlay?.panel.orderOut(nil)
    menuBarOverlay = nil
    store.prepareForTermination()
  }
}

// Keep a small catalogue of presentation literals in this source so the
// localization parity guard sees the complete native surface, including the
// labels that are otherwise generated from the capability manifest at runtime.
private let routerSurfaceCopy = [
  routerLocalized("Model Router"), routerLocalized("Open Model Router"), routerLocalized("Capability-driven controls"), routerLocalized("Read-only compatibility status"),
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

func usageResetCaption(
  _ date: Date,
  now: Date = Date(),
  localize: (String) -> String = routerLocalized
) -> String {
  let seconds = date.timeIntervalSince(now)
  if seconds <= 0 { return localize("resets soon") }
  return date.formatted(date: .abbreviated, time: .shortened)
}

func compactTokenCount(_ value: Double) -> String {
  if value >= 1_000_000 { return String(format: "%.1fM", value / 1_000_000) }
  if value >= 1_000 { return String(format: "%.1fk", value / 1_000) }
  return String(Int(value.rounded()))
}
