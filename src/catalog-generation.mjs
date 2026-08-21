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

const ROUTED_CATALOG_SCHEMA = Object.freeze({
  type: "object",
  required: ["models"],
  properties: {
    models: {
      type: "array",
      items: {
        type: "object",
        required: ["slug", "base_instructions", "model_messages", "supports_parallel_tool_calls"],
        properties: {
          slug: { type: "string" },
          base_instructions: { type: "string" },
          model_messages: {
            type: "object",
            required: ["instructions_template"],
            properties: { instructions_template: { type: "string" } },
          },
          supports_parallel_tool_calls: { type: "boolean" },
        },
      },
    },
  },
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
      if (process.platform === "win32" && path.basename(target) === "current" && existsSync(target)) {
        rmSync(target, { recursive: true, force: true });
      }
      return renameSync(source, target);
    },
    symlink(source, target, type) {
      if (process.platform !== "win32") return symlinkSync(source, target, type);
      try {
        return symlinkSync(source, target, type);
      } catch (error) {
        if (error?.code !== "EPERM") throw error;
        if (type === "dir") {
          return symlinkSync(path.resolve(path.dirname(target), source), target, "junction");
        }
        // Windows CI commonly lacks SeCreateSymbolicLinkPrivilege. This is a
        // compatibility link to an immutable generation file, never a
        // copy-in-place publication path; macOS keeps the one-pointer symlink
        // contract in production.
        return linkSync(path.resolve(path.dirname(target), source), target);
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
  return validateCatalogSchema({ models }, ROUTED_CATALOG_SCHEMA);
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
  const snapshots = legacyEntries(legacyPaths).map(([, target]) => captureRegularFile(operations, target));
  let pointerSwitched = false;
  try {
    // 0.147 and 0.149 share this Phase-1 routed contract. Native account
    // captures legitimately omit fields this router has no authority to
    // invent, so the validation applies to the fully shaped routed artifact.
    validateCatalogSchema(files["routed-models.json"], ROUTED_CATALOG_SCHEMA);
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
    operations.symlink(generation, nextPointer, "dir");
    operations.rename(nextPointer, currentDir);
    pointerSwitched = true;
    operations.fsyncDirectory(generationsDir);

    for (const [name, target] of legacyEntries(legacyPaths)) {
      const snapshot = snapshots.find((entry) => entry.path === target);
      if (snapshot?.preserve) continue;
      if (snapshot?.present) operations.unlink(target);
      operations.symlink(path.join("catalog-generations", "current", name), target, "file");
    }
    operations.fsyncDirectory(generationsDir);
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
