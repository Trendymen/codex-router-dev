import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { redactSensitive } from "../src/sensitive-redactor.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MATRIX = path.join(ROOT, "test", "acceptance", "acceptance-matrix.json");
const STATES = new Set(["passed", "failed", "pending", "not_run"]);
const KINDS = new Set(["unit", "build", "runtime", "ui", "visual", "isolated-install", "live"]);
const OUT_OF_SCOPE = "out_of_current_provider_scope";
const DEEPSEEK_QUOTA = "quota_approval_absent";
const NON_DEEPSEEK_PROVIDERS = new Set(["qwen-plan", "bailian", "glm"]);
const REQUIRED_KEYS = ["allowedNotRunReasons", "initialState", "kind", "profile", "provider", "requirementId"];
const ENTRY_KEYS = ["artifact", "generationId", "kind", "profile", "provider", "reason", "recordedAt", "requirementId", "sourceCommit", "state", "themeId"];
const REDACTED = "[REDACTED]";

function readJson(file, fallback) { return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : fallback; }

function safeText(value) {
  // Preserve only the shared redactor's line-level safe return. A second
  // closed guard catches URL/userinfo/query shapes that are not diagnostics.
  return String(value).split(/\r?\n/).map((line) => {
    const redacted = redactSensitive(line, { profile: "log" });
    return /(?:Basic\s+|Bearer\s+|X-API-Key\s*:|https?:\/\/[^/\s@]+@|[?&](?:token|key|secret)=[^\s&]+)/i.test(redacted) ? REDACTED : redacted;
  }).join("\n");
}

function matrixEvidence(matrix) {
  const identities = new Set(), requirementIds = new Set();
  for (const theme of matrix) {
    if (!theme || typeof theme !== "object" || !Array.isArray(theme.requiredEvidence)) throw new Error("invalid acceptance matrix");
    for (const required of theme.requiredEvidence) {
      if (!required || typeof required !== "object" || Object.keys(required).sort().join("\0") !== REQUIRED_KEYS.join("\0")) throw new Error("invalid acceptance evidence requirement");
      if (!KINDS.has(required.kind) || !/^[a-z][a-z0-9-]*$/.test(required.requirementId) || !/^[a-z][a-z0-9-]*$/.test(required.profile) || !(required.provider === null || /^(?:deepseek|qwen-plan|bailian|glm)$/.test(required.provider))) throw new Error("invalid acceptance evidence identity");
      if (!Array.isArray(required.allowedNotRunReasons) || required.allowedNotRunReasons.some((reason) => typeof reason !== "string" || !reason)) throw new Error("invalid acceptance evidence reasons");
      const identity = [theme.id, required.kind, required.requirementId, required.profile, required.provider].join("\0");
      if (identities.has(identity) || requirementIds.has(required.requirementId)) throw new Error("duplicate acceptance evidence identity");
      identities.add(identity); requirementIds.add(required.requirementId);
      const deepSeekLive = required.kind === "live" && required.provider === "deepseek";
      const nonDeepSeekLive = required.kind === "live" && NON_DEEPSEEK_PROVIDERS.has(required.provider);
      if (required.kind !== "live" && required.provider !== null) throw new Error("non-live evidence must not name a provider");
      if (required.kind === "live" && required.provider === null) throw new Error("live evidence must name a provider");
      if (required.initialState === "not_run") {
        if (!nonDeepSeekLive || required.allowedNotRunReasons.length !== 1 || required.allowedNotRunReasons[0] !== OUT_OF_SCOPE) throw new Error("only non-DeepSeek live evidence may start out of scope");
      } else if (required.initialState === "pending") {
        const expected = deepSeekLive ? [DEEPSEEK_QUOTA] : [];
        if (required.allowedNotRunReasons.length !== expected.length || required.allowedNotRunReasons.some((reason, index) => reason !== expected[index])) throw new Error("pending evidence has invalid not-run reasons");
      } else throw new Error("invalid acceptance evidence initial state");
    }
  }
}

export function loadMatrix(matrix = MATRIX) {
  const value = readJson(matrix, null);
  if (!Array.isArray(value)) throw new Error("acceptance matrix must be an array");
  matrixEvidence(value);
  return value;
}

function assertEntry(entry) {
  if (!entry || typeof entry !== "object" || Object.keys(entry).sort().join("\0") !== ENTRY_KEYS.join("\0")) throw new Error("invalid acceptance evidence schema");
  if (!KINDS.has(entry.kind) || !STATES.has(entry.state) || !/^[0-9a-f]{40,64}$/.test(entry.sourceCommit) || !/^[a-z][a-z0-9-]*$/.test(entry.requirementId) || !/^[a-z][a-z0-9-]*$/.test(entry.profile) || !(entry.provider === null || /^(?:deepseek|qwen-plan|bailian|glm)$/.test(entry.provider)) || !/^(?:[0-9a-f-]{36}|unfinalized)$/.test(entry.generationId) || !Number.isFinite(Date.parse(entry.recordedAt))) throw new Error("invalid acceptance evidence values");
  for (const key of ["themeId", "reason", "artifact"]) if (typeof entry[key] !== "string" || !entry[key] || /(?:Basic\s+|Bearer\s+|X-API-Key\s*:|(?:token|prompt|reasoning|tool[_-]?(?:args|arguments)|response[_-]?(?:body|content))\s*[=:]|https?:\/\/[^/\s@]+@)/i.test(entry[key])) throw new Error("unsafe acceptance evidence text");
  return Object.freeze({ ...entry });
}

function assertGeneration(generation) {
  if (generation === null) return null;
  if (!generation || typeof generation !== "object" || Object.keys(generation).sort().join("\0") !== ["generationId", "sourceCommit", "startedAt"].join("\0") || !/^[0-9a-f]{40,64}$/.test(generation.sourceCommit) || !/^[0-9a-f-]{36}$/.test(generation.generationId) || !Number.isFinite(Date.parse(generation.startedAt))) throw new Error("invalid final evidence generation");
  return generation;
}

function evidenceDocument(file) {
  const value = readJson(file, { schemaVersion: 1, finalGeneration: null, entries: [] });
  if (!value || value.schemaVersion !== 1 || !Array.isArray(value.entries)) throw new Error("invalid acceptance evidence document");
  assertGeneration(value.finalGeneration);
  for (const entry of value.entries) assertEntry(entry);
  return value;
}

function writeDocument(file, document) {
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, file);
}

function matchingRequirement(entry, matrix) {
  const matches = [];
  for (const theme of matrix) for (const required of theme.requiredEvidence) {
    if (entry.themeId !== theme.id || entry.kind !== required.kind) continue;
    if (["requirementId", "profile", "provider"].every((field) => entry[field] === undefined || entry[field] === required[field])) matches.push({ themeId: theme.id, ...required });
  }
  if (matches.length !== 1) throw new Error("acceptance evidence must identify exactly one required evidence row");
  return matches[0];
}

export function recordAcceptanceEvidence(entry, evidence, matrix = loadMatrix()) {
  const document = evidenceDocument(evidence), required = matchingRequirement(entry, matrix), generation = assertGeneration(document.finalGeneration);
  const { initialState: ignoredInitialState, allowedNotRunReasons: ignoredReasons, ...identity } = required;
  const { initialState: ignoredEntryInitialState, allowedNotRunReasons: ignoredEntryReasons, ...record } = entry;
  const valid = assertEntry({ ...record, ...identity, generationId: generation?.generationId || "unfinalized", recordedAt: new Date(Math.max(Date.now(), generation ? Date.parse(generation.startedAt) + 1 : 0)).toISOString() });
  document.entries.push(valid); writeDocument(evidence, document); return valid;
}

export function beginFinalEvidence({ evidence, sourceCommit }) {
  if (!/^[0-9a-f]{40,64}$/.test(sourceCommit)) throw new Error("sourceCommit must be a git object id");
  const document = evidenceDocument(evidence);
  document.finalGeneration = { generationId: randomUUID(), sourceCommit, startedAt: new Date().toISOString() };
  writeDocument(evidence, document); return document.finalGeneration;
}

export function profileEntries(profile, matrix = loadMatrix()) {
  const entries = matrix.flatMap((theme) => theme.requiredEvidence.filter((required) => required.profile === profile).map(({ kind, requirementId, provider, profile: requiredProfile }) => ({ themeId: theme.id, kind, requirementId, provider, profile: requiredProfile })));
  if (!entries.length) throw new Error(`unknown acceptance profile: ${profile}`);
  return entries;
}

function allowedNotRun(required, entry) {
  if (entry.state !== "not_run" || entry.kind !== "live") return false;
  if (entry.reason === DEEPSEEK_QUOTA) return required.provider === "deepseek" && required.allowedNotRunReasons.includes(DEEPSEEK_QUOTA);
  return entry.reason === OUT_OF_SCOPE && NON_DEEPSEEK_PROVIDERS.has(required.provider) && required.allowedNotRunReasons.includes(OUT_OF_SCOPE);
}

export function verifyAcceptance({ matrix = loadMatrix(), evidence, sourceCommit, final = false }) {
  matrixEvidence(matrix);
  const document = evidenceDocument(evidence), generation = document.finalGeneration, findings = [];
  if (final && generation?.sourceCommit !== sourceCommit) findings.push({ kind: "stale-generation", detail: "final evidence generation does not match sourceCommit" });
  for (const theme of matrix) for (const required of theme.requiredEvidence) {
    const candidates = document.entries.filter((entry) => entry.themeId === theme.id && entry.kind === required.kind && entry.requirementId === required.requirementId && entry.profile === required.profile && entry.provider === required.provider && entry.sourceCommit === sourceCommit && (!final || entry.generationId === generation?.generationId && Date.parse(entry.recordedAt) > Date.parse(generation?.startedAt)));
    if (candidates.length > 1) { findings.push({ kind: "ambiguous", themeId: theme.id, evidence: required.requirementId }); continue; }
    const entry = candidates[0];
    if (!entry) { if (final) findings.push({ kind: document.entries.some((candidate) => candidate.requirementId === required.requirementId) ? "stale" : "missing", themeId: theme.id, evidence: required.requirementId }); continue; }
    if (!final || entry.state === "passed" || allowedNotRun(required, entry)) continue;
    findings.push({ kind: entry.state === "not_run" ? "disallowed-not-run" : entry.state, themeId: theme.id, evidence: required.requirementId });
  }
  return findings;
}

function option(args, name, optional = false) {
  const index = args.indexOf(name);
  if (index === -1) { if (optional) return undefined; throw new Error(`missing ${name}`); }
  if (!args[index + 1]) throw new Error(`missing ${name}`); return args[index + 1];
}

function cli() {
  let [command, ...args] = process.argv.slice(2);
  if (command?.startsWith("--")) { args = [command, ...args]; command = "verify"; }
  if (command === "begin-final") { beginFinalEvidence({ evidence: path.resolve(option(args, "--evidence")), sourceCommit: option(args, "--source-commit") }); return; }
  const matrix = loadMatrix(option(args, "--matrix", true) ? path.resolve(option(args, "--matrix")) : MATRIX);
  if (command === "verify") {
    const findings = verifyAcceptance({ matrix, evidence: path.resolve(option(args, "--evidence")), sourceCommit: option(args, "--source-commit"), final: args.includes("--final") });
    for (const finding of findings) process.stdout.write(`${JSON.stringify(finding)}\n`);
    if (findings.length) process.exitCode = 1; return;
  }
  if (command !== "run") throw new Error("Usage: verify-acceptance begin-final|verify|run");
  const marker = args.indexOf("--"); if (marker === -1 || marker === args.length - 1) throw new Error("run requires a command after --");
  const profile = option(args, "--profile"), evidence = path.resolve(option(args, "--evidence")), artifact = path.resolve(option(args, "--artifact")), sourceCommit = option(args, "--source-commit"), commandArgs = args.slice(marker + 1);
  const result = spawnSync(commandArgs[0], commandArgs.slice(1), { encoding: "utf8" });
  mkdirSync(path.dirname(artifact), { recursive: true }); writeFileSync(artifact, safeText(`${result.stdout || ""}${result.stderr || ""}`), { mode: 0o600 });
  const state = result.status === 0 ? "passed" : "failed", reason = state === "passed" ? `profile ${profile} completed` : `profile ${profile} exited ${result.status ?? "signal"}`;
  for (const item of profileEntries(profile, matrix)) recordAcceptanceEvidence({ ...item, state, reason, artifact, sourceCommit }, evidence, matrix);
  process.exitCode = result.status ?? 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { cli(); } catch (error) { process.stderr.write(`${safeText(error.message)}\n`); process.exitCode = 2; }
}
