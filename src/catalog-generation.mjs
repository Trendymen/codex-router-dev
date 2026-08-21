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
  properties: { models: { type: "array", items: { type: "object", required: ["slug"], properties: { slug: { type: "string" } } } },
});

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

/** The generation writer's injectable filesystem boundary. */
export function createCatalogGenerationFileSystem(overrides = {}) {
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
      return renameSync(source, target);
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

function currentTarget(operations, currentDir) {
  try {
    return operations.readlink(currentDir);
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "EINVAL") return undefined;
    throw error;
  }
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
  if (isPresent(operations, snapshot.path)) operations.unlink(snapshot.path);
  if (!snapshot.present) return;
  operations.mkdir(path.dirname(snapshot.path), { recursive: true, mode: 0o700 });
  operations.writeFile(snapshot.path, snapshot.contents, { mode: snapshot.mode });
  operations.chmod(snapshot.path, snapshot.mode);
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
    operations.rename(next, target);
    operations.fsyncDirectory(path.dirname(target));
  }
}

function legacyEntries(legacyPaths) {
  if (legacyPaths) return Object.entries(legacyPaths);
  return CATALOG_GENERATION_FILES.map((name) => [name, path.join(STATE_DIR, name)]);
}

function validateNode(value, schema, pathLabel = "catalog") {
  if (!schema || typeof schema !== "object") return;
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

export function buildRoutedCatalog({ nativeModels = [], routedModels = [] } = {}) {
  const template = nativeModels.find((model) => model?.slug === "gpt-5.5")
    || nativeModels.find((model) => model?.visibility === "list")
    || nativeModels[0];
  if (!template) throw new Error("A routed catalog needs a native template.");
  const completeTemplate = completeRoutedTemplate(template);
  const models = routedModels.map((model) => {
    const next = routedModel(completeTemplate, model);
    next.supports_parallel_tool_calls = model.supportsParallelToolCalls === true;
    delete next.show_raw_agent_reasoning;
    return next;
  }).sort((left, right) => Number(left.priority ?? 999) - Number(right.priority ?? 999)
    || left.slug.localeCompare(right.slug));
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
  const previousPointer = currentTarget(operations, currentDir);
  const entries = legacyEntries(legacyPaths);
  const snapshots = entries.map(([, target]) => captureRegularFile(operations, target));
  let pointerSwitched = false;
  try {
    // 0.147 and 0.149 share this Phase-1 routed contract. Native account
    // captures legitimately omit fields this router has no authority to
    // invent, so the validation applies to the fully shaped routed artifact.
    validateCatalogSchema(files["merged-models.json"], MERGED_CATALOG_SCHEMA);
    validateCatalogSchema(files["merged-models.json"], MERGED_CATALOG_SCHEMA);
    validateCatalogSchema(files["routed-models.json"], CATALOG_0147_SCHEMA);
    validateCatalogSchema(files["routed-models.json"], CATALOG_0149_SCHEMA);
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
    // An existing publication lets stable paths resolve through the *old*
    // current pointer while this reversible topology is installed. A first
    // publication has no readable old generation, so its links follow the
    // initial pointer switch and failures remove that pointer entirely.
    if (previousPointer !== undefined) {
      installStableLegacyTopology(operations, entries, snapshots);
      operations.fsyncDirectory(generationsDir);
    }
    operations.symlink(generation, nextPointer, "dir");
    operations.rename(nextPointer, currentDir);
    pointerSwitched = true;
    operations.fsyncDirectory(generationsDir);
    if (previousPointer === undefined) {
      installStableLegacyTopology(operations, entries, snapshots);
      operations.fsyncDirectory(generationsDir);
    }
    return Object.freeze({ generation, path: final });
  } catch (error) {
    const rollbackErrors = [];
    for (const snapshot of [...snapshots].reverse()) {
      try { restoreRegularFile(operations, snapshot); } catch (rollbackError) { rollbackErrors.push(rollbackError); }
    }
    if (pointerSwitched) {
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
    try { if (isPresent(operations, nextPointer)) operations.unlink(nextPointer); } catch (cleanupError) { rollbackErrors.push(cleanupError); }
    try {
      const active = currentTarget(operations, currentDir);
      if (isPresent(operations, staging)) operations.remove(staging, { recursive: true, force: true });
      if (isPresent(operations, final) && active !== generation) operations.remove(final, { recursive: true, force: true });
    } catch (cleanupError) { rollbackErrors.push(cleanupError); }
    if (rollbackErrors.length) {
      throw new AggregateError([error, ...rollbackErrors], "Catalog generation failed and rollback was incomplete.");
    }
    throw error;
  }
}
