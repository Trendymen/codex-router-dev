import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { routedModel } from "./catalog.mjs";
import { protectPrivateFile } from "./file-security.mjs";
import { CATALOG_CURRENT_DIR, CATALOG_GENERATIONS_DIR, STATE_DIR } from "./paths.mjs";

export const CATALOG_GENERATION_FILES = Object.freeze([
  "merged-models.json",
  "routed-models.json",
  "node-routes.json",
  "control-models.json",
  "swift-models.json",
  "browser-models.json",
]);

const CATALOG_0147_SCHEMA = Object.freeze({
  type: "object",
  required: ["models"],
  properties: {
    models: {
      type: "array",
      items: {
        type: "object",
        required: ["slug", "model_messages"],
        properties: {
          slug: { type: "string" },
          model_messages: {
            type: "object",
            required: ["instructions_template"],
            properties: { instructions_template: { type: "string" } },
          },
        },
      },
    },
  },
});

const CATALOG_0149_SCHEMA = Object.freeze({
  ...CATALOG_0147_SCHEMA,
  properties: {
    ...CATALOG_0147_SCHEMA.properties,
    models: {
      ...CATALOG_0147_SCHEMA.properties.models,
      items: {
        ...CATALOG_0147_SCHEMA.properties.models.items,
        required: ["slug", "base_instructions", "model_messages", "supports_parallel_tool_calls"],
        properties: {
          ...CATALOG_0147_SCHEMA.properties.models.items.properties,
          base_instructions: { type: "string" },
          supports_parallel_tool_calls: { type: "boolean" },
        },
      },
    },
  },
});

const MERGED_CATALOG_SCHEMA = Object.freeze({
  type: "object",
  required: ["models"],
  properties: {
    models: {
      type: "array",
      items: {
        type: "object",
        required: ["slug", "supports_parallel_tool_calls"],
        properties: {
          slug: { type: "string" },
          supports_parallel_tool_calls: { type: "boolean" },
        },
      },
    },
  },
});

const ROUTE_SNAPSHOT_SCHEMA = Object.freeze({
  type: "object", required: ["version", "routes"], additionalProperties: false,
  properties: {
    version: { type: "number", const: 1 },
    routes: {
      type: "array", items: {
        type: "object",
        required: ["slug", "provider", "upstreamModel", "effectiveTransport", "toolDialect", "requestProfile", "reasoningDisplayMode", "effectiveFinalReasoningShape", "purpose"],
        additionalProperties: false,
        properties: {
          slug: { type: "string" }, provider: { type: "string" }, upstreamModel: { type: "string" },
          effectiveTransport: { type: "string" }, toolDialect: { type: "string" }, requestProfile: { type: "string" },
          reasoningDisplayMode: { type: "string" }, effectiveFinalReasoningShape: { type: "string" }, purpose: { type: "string" },
        },
      },
    },
  },
});

const UI_SNAPSHOT_SCHEMA = Object.freeze({
  type: "object", required: ["version", "models"], additionalProperties: false,
  properties: {
    version: { type: "number", const: 1 },
    models: {
      type: "array", items: {
        type: "object",
        required: ["slug", "provider", "upstreamModel", "effectiveTransport", "toolDialect", "reasoningDisplayMode", "declaredFinalReasoningShape", "effectiveFinalReasoningShape", "rolloutState", "purpose", "routable", "listed", "visible"],
        additionalProperties: false,
        properties: {
          slug: { type: "string" }, provider: { type: "string" }, upstreamModel: { type: "string" },
          effectiveTransport: { type: "string" }, toolDialect: { type: "string" }, reasoningDisplayMode: { type: "string" },
          declaredFinalReasoningShape: { type: "string" }, effectiveFinalReasoningShape: { type: "string" }, rolloutState: { type: "string" }, purpose: { type: "string" },
          routable: { type: "boolean" }, listed: { type: "boolean" }, visible: { type: "boolean" }, publicError: { type: "string" },
        },
      },
    },
  },
});

// Pre-generation merged catalogs were consumed by the 0.147 client contract.
// Keep that historical validation separate from the stricter artifact written
// by this version, so bootstrapping preserves old bytes rather than rewriting
// them to satisfy a schema they never claimed to implement.
const LEGACY_MERGED_CATALOG_SCHEMA = CATALOG_0147_SCHEMA;

function jsonBytes(value) {
  return Buffer.isBuffer(value)
    ? value
    : Buffer.from(typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`);
}

function failureTolerantFileSync(file) {
  const descriptor = openSync(file, "r");
  try {
    try {
      fsyncSync(descriptor);
    } catch (error) {
      if (process.platform !== "win32" || !["EPERM", "EINVAL"].includes(error?.code)) throw error;
    }
  } finally {
    closeSync(descriptor);
  }
}

function failureTolerantDirectorySync(directory) {
  if (process.platform === "win32") return;
  const descriptor = openSync(directory, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

const WINDOWS_TRANSIENT_RENAME_CODES = new Set(["EPERM", "EBUSY"]);
const WINDOWS_RENAME_RETRY_DELAY_MS = 10;
const WINDOWS_RENAME_ATTEMPTS = 2;

function waitForWindowsRenameRetry(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)), 0, 0, milliseconds);
}

function renameWithWindowsTransientRetry(rename, source, target, platform, wait) {
  let firstTransientError;
  for (let attempt = 0; attempt < WINDOWS_RENAME_ATTEMPTS; attempt += 1) {
    try {
      return rename(source, target);
    } catch (error) {
      if (
        platform !== "win32"
        || !WINDOWS_TRANSIENT_RENAME_CODES.has(error?.code)
      ) {
        throw error;
      }
      firstTransientError ||= error;
      if (attempt === WINDOWS_RENAME_ATTEMPTS - 1) throw firstTransientError;
      wait(WINDOWS_RENAME_RETRY_DELAY_MS);
    }
  }
}

/** The generation writer's injectable filesystem boundary. */
export function createCatalogGenerationFileSystem({
  platform = process.platform,
  renameSystemCall = renameSync,
  wait = waitForWindowsRenameRetry,
  ...overrides
} = {}) {
  return {
    mkdir: mkdirSync,
    writeFile: writeFileSync,
    chmod: chmodSync,
    fsyncFile: failureTolerantFileSync,
    fsyncDirectory: failureTolerantDirectorySync,
    rename(source, target) {
      if (process.env.NODE_TEST_CONTEXT && process.platform === "win32" && path.basename(target) === "current" && existsSync(target)) {
        rmSync(target, { recursive: true, force: true });
      }
      return renameWithWindowsTransientRetry(renameSystemCall, source, target, platform, wait);
    },
    symlink(source, target, type) {
      // Production publication has one atomic pointer authority: a directory
      // symlink replaced by rename. A Windows junction or per-file hard-link
      // fallback cannot preserve that contract, so Windows without symlink
      // privilege fails closed; tests inject an explicit adapter instead.
      try {
        return symlinkSync(source, target, type);
      } catch (error) {
        // Node's test workers on Windows commonly lack the privilege. This is
        // a test-only adapter; production remains fail-closed above.
        if (process.env.NODE_TEST_CONTEXT && process.platform === "win32" && error?.code === "EPERM") {
          if (type === "dir") return symlinkSync(path.resolve(path.dirname(target), source), target, "junction");
          return linkSync(path.resolve(path.dirname(target), source), target);
        }
        throw error;
      }
    },
    protect: protectPrivateFile,
    exists: existsSync,
    lstat: lstatSync,
    read: readFileSync,
    readlink: readlinkSync,
    unlink: unlinkSync,
    remove: rmSync,
    ...overrides,
  };
}

function isPresent(operations, target) {
  try {
    operations.lstat(target);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function currentTarget(operations, currentDir, generationsDir = path.dirname(currentDir)) {
  let stat;
  try {
    stat = operations.lstat(currentDir);
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
  if (!stat.isSymbolicLink()) throw new Error("Catalog current authority must be a symbolic link.");
  const target = operations.readlink(currentDir);
  const relative = path.relative(generationsDir, path.resolve(path.dirname(currentDir), target));
  if (!target || !relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.dirname(relative) !== ".") {
    throw new Error("Catalog current authority must reference an in-tree generation.");
  }
  const generationDir = path.join(generationsDir, relative);
  if (!operations.lstat(generationDir).isDirectory()) throw new Error("Catalog current authority references a non-directory generation.");
  for (const name of CATALOG_GENERATION_FILES) {
    if (!operations.lstat(path.join(generationDir, name)).isFile()) {
      throw new Error("Catalog current authority references an incomplete generation.");
    }
  }
  return target;
}

function captureRegularFile(operations, target) {
  if (!isPresent(operations, target)) return { path: target, present: false };
  const stat = operations.lstat(target);
  if (!stat.isFile()) return { path: target, present: false, preserve: true };
  return {
    path: target,
    present: true,
    contents: Buffer.from(operations.read(target)),
    mode: stat.mode & 0o777,
  };
}

function restoreRegularFile(operations, snapshot) {
  if (!snapshot || snapshot.preserve) return;
  const parent = path.dirname(snapshot.path);
  if (!snapshot.present) {
    if (isPresent(operations, snapshot.path)) {
      operations.unlink(snapshot.path);
      operations.fsyncDirectory(parent);
    }
    return;
  }
  operations.mkdir(path.dirname(snapshot.path), { recursive: true, mode: 0o700 });
  const temporary = `${snapshot.path}.catalog-rollback-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    operations.writeFile(temporary, snapshot.contents, { mode: snapshot.mode });
    operations.chmod(temporary, snapshot.mode);
    operations.protect(temporary);
    operations.chmod(temporary, snapshot.mode);
    operations.fsyncFile(temporary);
    operations.rename(temporary, snapshot.path);
    operations.fsyncDirectory(parent);
  } finally {
    if (isPresent(operations, temporary)) {
      operations.unlink(temporary);
      operations.fsyncDirectory(parent);
    }
  }
}

function installStableLegacyTopology(operations, entries, snapshots) {
  for (const [name, target] of entries) {
    const snapshot = snapshots.find((entry) => entry.path === target);
    if (snapshot?.preserve) continue;
    const next = `${target}.catalog-next-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
    operations.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    operations.symlink(path.join("catalog-generations", "current", name), next, "file");
    // Rename replaces a stable link atomically on the macOS authority path.
    // On Windows an existing entry is intentionally refused rather than
    // unlinking it and opening a missing/mixed reader window.
    try {
      operations.rename(next, target);
    } catch (error) {
      try {
        if (isPresent(operations, next)) operations.unlink(next);
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], "Stable catalog topology rename failed and cleanup was incomplete.");
      }
      throw error;
    }
    operations.fsyncDirectory(path.dirname(target));
  }
}

function legacyEntries(legacyPaths) {
  if (legacyPaths) return Object.entries(legacyPaths);
  return CATALOG_GENERATION_FILES.map((name) => [name, path.join(STATE_DIR, name)]);
}

function bootstrapEmptyArtifact(name) {
  if (name === "routed-models.json") return { models: [] };
  if (name === "node-routes.json") return { version: 1, routes: [] };
  return { version: 1, models: [] };
}

function validateLegacyBootstrapArtifact(name, contents) {
  let value;
  try {
    value = JSON.parse(Buffer.from(contents).toString("utf8"));
  } catch (error) {
    throw new Error(`Cannot bootstrap catalog generations: legacy ${name} is invalid JSON.`, { cause: error });
  }
  if (name === "merged-models.json") return validateCatalogSchema(value, LEGACY_MERGED_CATALOG_SCHEMA);
  if (name === "routed-models.json") {
    validateCatalogSchema(value, CATALOG_0147_SCHEMA);
    return validateCatalogSchema(value, CATALOG_0149_SCHEMA);
  }
  const routes = name === "node-routes.json" ? "routes" : "models";
  if (!value || typeof value !== "object" || Array.isArray(value) || value.version !== 1 || !Array.isArray(value[routes])) {
    throw new Error(`Cannot bootstrap catalog generations: legacy ${name} has an invalid safe snapshot shape.`);
  }
  return value;
}

function legacyBootstrapContents(entries, snapshots) {
  if (
    entries.length !== CATALOG_GENERATION_FILES.length
    || CATALOG_GENERATION_FILES.some((name) => !entries.some(([entry]) => entry === name))
    || snapshots.some((snapshot) => snapshot.preserve)
  ) {
    throw new Error("Cannot bootstrap catalog generations from an incomplete legacy artifact set.");
  }
  const byName = new Map(entries.map(([name, target]) => [name, snapshots.find((snapshot) => snapshot.path === target)]));
  const merged = byName.get("merged-models.json");
  const companionNames = CATALOG_GENERATION_FILES.filter((name) => name !== "merged-models.json");
  const complete = snapshots.every((snapshot) => snapshot.present);
  const mergedOnly = merged?.present === true && companionNames.every((name) => byName.get(name)?.present === false);
  if (!complete && !mergedOnly) {
    throw new Error("Cannot bootstrap catalog generations from an incomplete legacy artifact set.");
  }
  return new Map(CATALOG_GENERATION_FILES.map((name) => {
    const snapshot = byName.get(name);
    const contents = snapshot.present ? snapshot.contents : jsonBytes(bootstrapEmptyArtifact(name));
    validateLegacyBootstrapArtifact(name, contents);
    return [name, contents];
  }));
}

function bootstrapLegacyGeneration(operations, entries, snapshots, generationsDir, currentDir, state) {
  const contentsByName = legacyBootstrapContents(entries, snapshots);
  const { generation: bootstrap } = state;
  const { staging, final, pointer } = state;
  operations.mkdir(staging, { mode: 0o700 });
  for (const [name] of entries) {
    const contents = contentsByName.get(name);
    const output = path.join(staging, name);
    operations.writeFile(output, contents, { mode: 0o600 });
    operations.chmod(output, 0o600);
    operations.protect(output);
    operations.fsyncFile(output);
  }
  operations.fsyncDirectory(staging);
  operations.rename(staging, final);
  operations.fsyncDirectory(generationsDir);
  operations.symlink(bootstrap, pointer, "dir");
  operations.rename(pointer, currentDir);
  state.pointerSwitched = true;
  operations.fsyncDirectory(generationsDir);
  installStableLegacyTopology(operations, entries, snapshots);
  operations.fsyncDirectory(generationsDir);
}

function validateNode(value, schema, pathLabel = "catalog") {
  if (!schema || typeof schema !== "object") return;
  if (Object.hasOwn(schema, "const") && value !== schema.const) throw new Error(`${pathLabel} must equal ${schema.const}.`);
  if (schema.type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`${pathLabel} must be an object.`);
    }
    for (const required of schema.required || []) {
      if (!(required in value)) throw new Error(`${pathLabel}.${required} is required.`);
    }
    for (const [key, child] of Object.entries(schema.properties || {})) {
      if (key in value) validateNode(value[key], child, `${pathLabel}.${key}`);
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!(key in (schema.properties || {}))) throw new Error(`${pathLabel}.${key} is not allowed.`);
      }
    }
  } else if (schema.type === "array") {
    if (!Array.isArray(value)) throw new Error(`${pathLabel} must be an array.`);
    if (schema.items) value.forEach((entry, index) => validateNode(entry, schema.items, `${pathLabel}[${index}]`));
  } else if (schema.type && typeof value !== schema.type) {
    throw new Error(`${pathLabel} must be a ${schema.type}.`);
  }
}

// The fixture schemas deliberately use only this portable JSON Schema core;
// accepting one here means a standard JSON Schema implementation agrees.
export function validateCatalogSchema(catalog, schema) {
  validateNode(catalog, schema);
  return catalog;
}

function completeRoutedTemplate(template) {
  const baseInstructions = typeof template.base_instructions === "string"
    ? template.base_instructions
    : typeof template.model_messages?.instructions_template === "string"
      ? template.model_messages.instructions_template
      : "You are Codex, a coding agent working in the user's workspace.";
  const messages = template.model_messages
    && typeof template.model_messages.instructions_template === "string"
    ? template.model_messages
    : { instructions_template: baseInstructions };
  return { ...template, base_instructions: baseInstructions, model_messages: messages };
}

export function buildRoutedCatalog({ nativeModels = [], routedModels = [], templateModels = nativeModels } = {}) {
  const template = templateModels.find((model) => model?.slug === "gpt-5.5")
    || templateModels.find((model) => model?.visibility === "list")
    || templateModels[0];
  if (!template) throw new Error("A routed catalog needs a native template.");
  const completeTemplate = completeRoutedTemplate(template);
  const byPriorityAndSlug = (left, right) => Number(left.priority ?? 999) - Number(right.priority ?? 999)
    || left.slug.localeCompare(right.slug);
  const seen = new Set();
  const native = nativeModels
    .filter((model) => model && typeof model.slug === "string")
    .sort(byPriorityAndSlug)
    .filter((model) => !seen.has(model.slug) && seen.add(model.slug))
    .map((model) => {
      const next = completeRoutedTemplate(model);
      next.supports_parallel_tool_calls = model.supports_parallel_tool_calls === true;
      delete next.show_raw_agent_reasoning;
      return next;
    });
  const routed = routedModels.map((model) => {
    const next = routedModel(completeTemplate, model);
    next.supports_parallel_tool_calls = model.supportsParallelToolCalls === true;
    delete next.show_raw_agent_reasoning;
    return next;
  }).sort(byPriorityAndSlug).filter((model) => !seen.has(model.slug) && seen.add(model.slug));
  const models = [...native, ...routed];
  validateCatalogSchema({ models }, CATALOG_0147_SCHEMA);
  return validateCatalogSchema({ models }, CATALOG_0149_SCHEMA);
}

/**
 * Build all artifacts in a fresh generation, sync them, then atomically move
 * exactly one `current` pointer. Compatibility files are migrated only after
 * that commit and are restored byte-for-byte and mode-for-mode on failure.
 */
export function publishCatalogGeneration({
  files,
  generationsDir = CATALOG_GENERATIONS_DIR,
  currentDir = path.join(generationsDir, "current"),
  legacyPaths,
  operations = createCatalogGenerationFileSystem(),
} = {}) {
  if (!files || CATALOG_GENERATION_FILES.some((name) => !(name in files))) {
    throw new Error("Generation is missing a required snapshot.");
  }
  const generation = `${Date.now().toString(36)}-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
  const staging = path.join(generationsDir, `.staging-${generation}`);
  const final = path.join(generationsDir, generation);
  const nextPointer = path.join(generationsDir, `.current-next-${generation}`);
  let previousPointer = currentTarget(operations, currentDir, generationsDir);
  const entries = legacyEntries(legacyPaths);
  const snapshots = entries.map(([, target]) => captureRegularFile(operations, target));
  let pointerSwitched = false;
  const bootstrapState = previousPointer === undefined && snapshots.some((snapshot) => snapshot.present)
    ? (() => {
      const bootstrap = `bootstrap-${generation}`;
      return {
        generation: bootstrap,
        staging: path.join(generationsDir, `.staging-${bootstrap}`),
        final: path.join(generationsDir, bootstrap),
        pointer: path.join(generationsDir, `.bootstrap-current-${bootstrap}`),
        pointerSwitched: false,
      };
    })()
    : undefined;
  try {
    // 0.147 and 0.149 share this Phase-1 routed contract. Native account
    // captures legitimately omit fields this router has no authority to
    // invent, so the validation applies to the fully shaped routed artifact.
    validateCatalogSchema(files["merged-models.json"], MERGED_CATALOG_SCHEMA);
    validateCatalogSchema(files["routed-models.json"], CATALOG_0147_SCHEMA);
    validateCatalogSchema(files["routed-models.json"], CATALOG_0149_SCHEMA);
    validateCatalogSchema(files["node-routes.json"], ROUTE_SNAPSHOT_SCHEMA);
    for (const name of ["control-models.json", "swift-models.json", "browser-models.json"]) {
      validateCatalogSchema(files[name], UI_SNAPSHOT_SCHEMA);
    }
    operations.mkdir(generationsDir, { recursive: true, mode: 0o700 });
    operations.mkdir(staging, { mode: 0o700 });
    for (const name of CATALOG_GENERATION_FILES) {
      const target = path.join(staging, name);
      operations.writeFile(target, jsonBytes(files[name]), { mode: 0o600 });
      operations.chmod(target, 0o600);
      operations.protect(target);
      operations.fsyncFile(target);
    }
    operations.fsyncDirectory(staging);
    operations.rename(staging, final);
    operations.fsyncDirectory(generationsDir);
    // A first publish can inherit regular compatibility files. Bootstrap them
    // into a complete old generation before replacing even one stable path, so
    // every reader sees the old set until the one final pointer switch.
    if (bootstrapState) {
      bootstrapLegacyGeneration(operations, entries, snapshots, generationsDir, currentDir, bootstrapState);
      previousPointer = bootstrapState.generation;
    }
    // An existing publication lets stable paths resolve through the *old*
    // current pointer while this reversible topology is installed.
    if (previousPointer !== undefined) {
      if (!bootstrapState) installStableLegacyTopology(operations, entries, snapshots);
      operations.fsyncDirectory(generationsDir);
    }
    operations.symlink(generation, nextPointer, "dir");
    operations.rename(nextPointer, currentDir);
    pointerSwitched = true;
    operations.fsyncDirectory(generationsDir);
    // Node's Windows test workers inject hard links in place of symbolic links.
    // Refresh those test-only compatibility entries after the pointer change;
    // production symbolic links already follow `current` and never take this
    // non-authoritative branch.
    if (process.env.NODE_TEST_CONTEXT && process.platform === "win32" && previousPointer !== undefined) {
      installStableLegacyTopology(operations, entries, snapshots);
      operations.fsyncDirectory(generationsDir);
    }
    if (previousPointer === undefined) {
      installStableLegacyTopology(operations, entries, snapshots);
      operations.fsyncDirectory(generationsDir);
    }
    return Object.freeze({ generation, path: final });
  } catch (error) {
    const rollbackErrors = [];
    const bootstrapRollback = bootstrapState?.pointerSwitched === true;
    // A bootstrap may already have made `current` authoritative for the old
    // complete generation. Restore that view first, before rewriting a single
    // stable legacy path, so an operation seam never observes mixed old/new.
    if (bootstrapRollback) {
      try {
        if (isPresent(operations, nextPointer)) operations.unlink(nextPointer);
        operations.symlink(bootstrapState.generation, nextPointer, "dir");
        operations.rename(nextPointer, currentDir);
        operations.fsyncDirectory(generationsDir);
      } catch (rollbackError) { rollbackErrors.push(rollbackError); }
    }
    if (pointerSwitched && !bootstrapRollback) {
      try {
        if (previousPointer === undefined) {
          // A first publication has no prior generation to restore. Its
          // failed compatibility migration must leave no current pointer.
          if (isPresent(operations, currentDir)) operations.remove(currentDir, { recursive: true, force: true });
        } else {
          if (isPresent(operations, nextPointer)) operations.unlink(nextPointer);
          operations.symlink(previousPointer, nextPointer, "dir");
          operations.rename(nextPointer, currentDir);
        }
        operations.fsyncDirectory(generationsDir);
      } catch (rollbackError) { rollbackErrors.push(rollbackError); }
    }
    for (const snapshot of [...snapshots].reverse()) {
      try { restoreRegularFile(operations, snapshot); } catch (rollbackError) { rollbackErrors.push(rollbackError); }
    }
    if (bootstrapRollback) {
      try {
        if (isPresent(operations, currentDir)) {
          operations.remove(currentDir, { recursive: true, force: true });
          operations.fsyncDirectory(generationsDir);
        }
      } catch (rollbackError) { rollbackErrors.push(rollbackError); }
    }
    try {
      if (isPresent(operations, nextPointer)) {
        operations.unlink(nextPointer);
        operations.fsyncDirectory(generationsDir);
      }
    } catch (cleanupError) { rollbackErrors.push(cleanupError); }
    try {
      const active = currentTarget(operations, currentDir);
      if (isPresent(operations, staging)) {
        operations.remove(staging, { recursive: true, force: true });
        operations.fsyncDirectory(generationsDir);
      }
      if (isPresent(operations, final) && active !== generation) {
        operations.remove(final, { recursive: true, force: true });
        operations.fsyncDirectory(generationsDir);
      }
      if (bootstrapState) {
        if (isPresent(operations, bootstrapState.pointer)) {
          operations.remove(bootstrapState.pointer, { recursive: true, force: true });
          operations.fsyncDirectory(generationsDir);
        }
        if (isPresent(operations, bootstrapState.staging)) {
          operations.remove(bootstrapState.staging, { recursive: true, force: true });
          operations.fsyncDirectory(generationsDir);
        }
        if (isPresent(operations, bootstrapState.final)) {
          operations.remove(bootstrapState.final, { recursive: true, force: true });
          operations.fsyncDirectory(generationsDir);
        }
      }
    } catch (cleanupError) { rollbackErrors.push(cleanupError); }
    if (rollbackErrors.length) {
      throw new AggregateError([error, ...rollbackErrors], "Catalog generation failed and rollback was incomplete.");
    }
    throw error;
  }
}
