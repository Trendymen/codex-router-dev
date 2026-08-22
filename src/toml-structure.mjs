function ambiguousToml(line, detail) {
  throw new Error(`Refusing ambiguous TOML structure at line ${line}: ${detail}.`);
}

function tomlBasicKey(raw) {
  let decoded = "";
  for (let index = 0; index < raw.length; index += 1) {
    const character = raw[index];
    if (character !== "\\") {
      decoded += character;
      continue;
    }
    const escape = raw[++index];
    const simple = {
      b: "\b",
      t: "\t",
      n: "\n",
      f: "\f",
      r: "\r",
      '"': '"',
      "\\": "\\",
    }[escape];
    if (simple !== undefined) {
      decoded += simple;
      continue;
    }
    const digits = escape === "u" ? 4 : escape === "U" ? 8 : 0;
    const code = digits ? raw.slice(index + 1, index + 1 + digits) : "";
    if (!digits || !new RegExp(`^[0-9a-fA-F]{${digits}}$`).test(code)) {
      return undefined;
    }
    const value = Number.parseInt(code, 16);
    if (value > 0x10ffff || (value >= 0xd800 && value <= 0xdfff)) return undefined;
    decoded += String.fromCodePoint(value);
    index += digits;
  }
  return decoded;
}

function tomlDottedKey(raw) {
  const parts = [];
  let index = 0;
  while (index < raw.length) {
    while (/\s/.test(raw[index] || "")) index += 1;
    if (index >= raw.length) return undefined;
    const quote = raw[index] === '"' || raw[index] === "'" ? raw[index++] : undefined;
    let value = "";
    if (quote) {
      let closed = false;
      while (index < raw.length) {
        if (raw[index] === quote) {
          index += 1;
          closed = true;
          break;
        }
        if (quote === '"' && raw[index] === "\\") {
          const escapeStart = index;
          index += 2;
          if (raw[escapeStart + 1] === "u") index += 4;
          else if (raw[escapeStart + 1] === "U") index += 8;
          value += raw.slice(escapeStart, index);
        } else {
          value += raw[index++];
        }
      }
      if (!closed) return undefined;
      if (quote === '"') value = tomlBasicKey(value);
      if (value === undefined) return undefined;
    } else {
      const start = index;
      while (index < raw.length && raw[index] !== "." && !/\s/.test(raw[index])) {
        index += 1;
      }
      value = raw.slice(start, index);
      if (!value || !/^[A-Za-z0-9_-]+$/.test(value)) return undefined;
    }
    parts.push(value);
    while (/\s/.test(raw[index] || "")) index += 1;
    if (index === raw.length) return parts;
    if (raw[index] !== ".") return undefined;
    index += 1;
  }
  return undefined;
}

function tableHeaderAtLine(line, lineNumber) {
  let index = 0;
  while (/\s/.test(line[index] || "")) index += 1;
  if (line[index] !== "[") return undefined;
  const array = line[index + 1] === "[";
  index += array ? 2 : 1;
  const start = index;
  let quote;
  let escaped = false;
  let end = -1;
  while (index < line.length) {
    const character = line[index];
    if (quote === '"') {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = undefined;
      index += 1;
      continue;
    }
    if (quote === "'") {
      if (character === quote) quote = undefined;
      index += 1;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      index += 1;
      continue;
    }
    if (character === "[") {
      ambiguousToml(lineNumber, "an unquoted opening bracket appears in a table header");
    }
    if (character === "]") {
      if (array && line[index + 1] !== "]") {
        ambiguousToml(lineNumber, "an array-table header has only one closing bracket");
      }
      end = index;
      index += array ? 2 : 1;
      break;
    }
    index += 1;
  }
  if (quote) ambiguousToml(lineNumber, "a quoted table key is unterminated");
  if (end === -1) ambiguousToml(lineNumber, "a table header is unterminated");
  const remainder = line.slice(index).trimStart();
  if (remainder && !remainder.startsWith("#")) {
    ambiguousToml(lineNumber, "unexpected text follows a table header");
  }
  const path = tomlDottedKey(line.slice(start, end).trim());
  if (!path) ambiguousToml(lineNumber, "the table key cannot be decoded safely");
  return path;
}

function assignmentAtLine(line, lineNumber) {
  let quote;
  let escaped = false;
  let equals = -1;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (quote === '"') {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = undefined;
      continue;
    }
    if (quote === "'") {
      if (character === quote) quote = undefined;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === "#") break;
    if (character === "=") {
      equals = index;
      break;
    }
  }
  if (equals === -1) return undefined;
  const key = tomlDottedKey(line.slice(0, equals).trim());
  if (!key) ambiguousToml(lineNumber, "an assignment key cannot be decoded safely");
  const rawValue = line.slice(equals + 1).trimStart();
  const boolean = rawValue.match(/^(true|false)(?:\s*(?:#.*)?)?$/);
  if (boolean) return { key, kind: "boolean", value: boolean[1] === "true" };
  const quoteCharacter = rawValue[0];
  if (quoteCharacter !== '"' && quoteCharacter !== "'") {
    return { key, kind: "other", rawValue };
  }
  if (rawValue.startsWith(quoteCharacter.repeat(3))) {
    return { key, kind: "multiline-string" };
  }
  let index = 1;
  let body = "";
  let closed = false;
  while (index < rawValue.length) {
    if (quoteCharacter === '"' && rawValue[index] === "\\") {
      const start = index;
      index += 2;
      if (rawValue[start + 1] === "u") index += 4;
      else if (rawValue[start + 1] === "U") index += 8;
      body += rawValue.slice(start, index);
      continue;
    }
    if (rawValue[index] === quoteCharacter) {
      index += 1;
      closed = true;
      break;
    }
    body += rawValue[index++];
  }
  if (!closed) ambiguousToml(lineNumber, "a single-line string is unterminated");
  const remainder = rawValue.slice(index).trimStart();
  if (remainder && !remainder.startsWith("#")) {
    ambiguousToml(lineNumber, "unexpected text follows a string assignment");
  }
  const value = quoteCharacter === '"' ? tomlBasicKey(body) : body;
  if (value === undefined) ambiguousToml(lineNumber, "a basic string escape is invalid");
  return { key, kind: "string", value };
}

function uncommentTomlValue(rawValue) {
  let quote;
  let escaped = false;
  let output = "";
  for (let index = 0; index < rawValue.length; index += 1) {
    const character = rawValue[index];
    if (quote === '"') {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = undefined;
      output += character;
      continue;
    }
    if (quote === "'") {
      if (character === quote) quote = undefined;
      output += character;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      output += character;
      continue;
    }
    if (character === "#") {
      while (index < rawValue.length && rawValue[index] !== "\n") index += 1;
      if (index < rawValue.length) output += "\n";
      continue;
    }
    output += character;
  }
  return quote ? undefined : output;
}

function validTomlDateOrTime(value) {
  const dateTime = value.match(/^(\d{4})-(\d{2})-(\d{2})[Tt ](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))?$/);
  const date = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const time = value.match(/^(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?$/);
  const dateParts = dateTime || date;
  if (dateParts) {
    const [, year, month, day] = dateParts;
    const yearNumber = Number(year);
    const monthNumber = Number(month);
    const dayNumber = Number(day);
    if (monthNumber < 1 || monthNumber > 12) return false;
    const days = new Date(Date.UTC(yearNumber, monthNumber, 0)).getUTCDate();
    if (dayNumber < 1 || dayNumber > days) return false;
  }
  const timeParts = dateTime || time;
  if (!timeParts) return Boolean(dateParts);
  const start = dateTime ? 4 : 1;
  const hour = Number(timeParts[start]);
  const minute = Number(timeParts[start + 1]);
  const second = Number(timeParts[start + 2]);
  if (hour > 23 || minute > 59 || second > 60) return false;
  if (dateTime && timeParts[7] !== undefined && (Number(timeParts[7]) > 23 || Number(timeParts[8]) > 59)) return false;
  return true;
}

function validTomlInteger(value) {
  const sign = value[0] === "+" || value[0] === "-" ? value[0] : "";
  const unsigned = sign ? value.slice(1) : value;
  const decimal = /^(?:0|[1-9](?:_?\d)*)$/;
  const based = /^0(?:x[0-9A-Fa-f](?:_?[0-9A-Fa-f])*|o[0-7](?:_?[0-7])*|b[01](?:_?[01])*)$/;
  if (decimal.test(unsigned)) {
    const magnitude = BigInt(unsigned.replaceAll("_", ""));
    const integer = sign === "-" ? -magnitude : magnitude;
    return integer >= -9223372036854775808n && integer <= 9223372036854775807n;
  }
  if (sign || !based.test(value)) return false;
  return BigInt(value.replaceAll("_", "")) <= 9223372036854775807n;
}

function validTomlOtherPrimitive(value) {
  const decimal = "(?:0|[1-9](?:_?\\d)*)";
  const digitSequence = "\\d(?:_?\\d)*";
  const float = new RegExp(`^[+-]?(?:${decimal}\\.${digitSequence}(?:[eE][+-]?${digitSequence})?|${decimal}[eE][+-]?${digitSequence})$`);
  return value === "true" || value === "false" || validTomlInteger(value) || float.test(value) ||
    /^[+-]?(?:inf|nan)$/.test(value) || validTomlDateOrTime(value);
}

// Validate the subset left as `other` by the structural scanner. This is
// deliberately a small, complete one-line value parser: status consumers may
// ignore unrelated values only after proving they are syntactically TOML, not
// merely after seeing an equals sign.
function trustedTomlOtherValue(rawValue) {
  const source = uncommentTomlValue(rawValue);
  if (source === undefined) return false;
  let index = 0;
  const skipSpace = () => {
    while (/\s/.test(source[index] || "")) index += 1;
  };
  const parseString = () => {
    const quote = source[index++];
    let body = "";
    let closed = false;
    while (index < source.length) {
      const character = source[index++];
      if (quote === '"' && character === "\\") {
        body += character;
        if (index >= source.length) return false;
        body += source[index++];
        if (body.at(-1) === "u") body += source.slice(index, index += 4);
        else if (body.at(-1) === "U") body += source.slice(index, index += 8);
        continue;
      }
      if (character === quote) {
        closed = true;
        break;
      }
      body += character;
    }
    return closed && (quote !== '"' || tomlBasicKey(body) !== undefined);
  };
  const pathKey = (parts) => parts.join("\u0000");
  const isPrefix = (prefix, candidate) =>
    prefix.length <= candidate.length && prefix.every((part, index) => candidate[index] === part);
  const parseInlineKey = () => {
    const start = index;
    let quote;
    let escaped = false;
    while (index < source.length) {
      const character = source[index];
      if (quote === '"') {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === quote) quote = undefined;
        index += 1;
        continue;
      }
      if (quote === "'") {
        if (character === quote) quote = undefined;
        index += 1;
        continue;
      }
      if (character === '"' || character === "'") {
        quote = character;
        index += 1;
        continue;
      }
      if (character === "=") return tomlDottedKey(source.slice(start, index).trim());
      if (character === "," || character === "}") return false;
      index += 1;
    }
    return undefined;
  };
  const parseValue = (inlinePath, inlineEntries) => {
    skipSpace();
    const character = source[index];
    if (character === '"' || character === "'") return parseString();
    if (character === "[") {
      index += 1;
      skipSpace();
      if (source[index] === "]") {
        index += 1;
        return true;
      }
      while (true) {
        if (!parseValue()) return false;
        skipSpace();
        if (source[index] === "]") {
          index += 1;
          return true;
        }
        if (source[index] !== ",") return false;
        index += 1;
        skipSpace();
        if (source[index] === "]") {
          index += 1;
          return true;
        }
      }
    }
    if (character === "{") {
      return parseInlineTable(inlinePath || [], inlineEntries || new Map());
    }
    const start = index;
    while (index < source.length && !",]}".includes(source[index])) index += 1;
    const primitive = source.slice(start, index).trimEnd();
    return Boolean(primitive) && validTomlOtherPrimitive(primitive);
  };
  const parseInlineTable = (prefix, entries) => {
      index += 1;
      skipSpace();
      if (source[index] === "}") {
        index += 1;
        return true;
      }
      while (true) {
        const key = parseInlineKey();
        if (!key || source[index] !== "=") return false;
        index += 1;
        skipSpace();
        const valuePath = [...prefix, ...key];
        const inline = source[index] === "{";
        for (const existing of entries.values()) {
          if (samePath(existing.path, valuePath)) return false;
          if (isPrefix(existing.path, valuePath)) {
            if (existing.kind !== "inline" || !isPrefix(existing.path, prefix)) return false;
          } else if (isPrefix(valuePath, existing.path)) {
            return false;
          }
        }
        entries.set(pathKey(valuePath), { path: valuePath, kind: inline ? "inline" : "value" });
        if (!parseValue(inline ? valuePath : undefined, inline ? entries : undefined)) return false;
        skipSpace();
        if (source[index] === "}") {
          index += 1;
          return true;
        }
        if (source[index] !== ",") return false;
        index += 1;
        skipSpace();
      }
  };

  if (!parseValue()) return false;
  skipSpace();
  return index === source.length;
}

// A small fail-closed structural lexer, not a general TOML value parser. It
// identifies real table boundaries and active assignments while ignoring
// table-looking text and assignments inside multiline strings.
export function scanTomlDocument(contents) {
  const lines = String(contents || "").split("\n");
  const headers = [];
  const assignments = [];
  let tablePath = [];
  let multiline;
  let arrayDepth = 0;
  let pendingArrayAssignment;

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    const lineNumber = lineIndex + 1;
    if (!multiline && arrayDepth === 0) {
      const header = tableHeaderAtLine(line, lineNumber);
      if (header) {
        tablePath = header;
        headers.push({ index: lineIndex, path: header });
        continue;
      }
      const assignment = assignmentAtLine(line, lineNumber);
      if (assignment) {
        const entry = { index: lineIndex, tablePath: [...tablePath], ...assignment };
        assignments.push(entry);
        if (entry.kind === "other" && entry.rawValue.trimStart().startsWith("[")) {
          pendingArrayAssignment = entry;
        }
      } else if (line.trim() && !line.trimStart().startsWith("#")) {
        ambiguousToml(lineNumber, "unrecognized active TOML content");
      }
    }

    let index = 0;
    while (index < line.length) {
      if (multiline) {
        const quote = multiline === "basic" ? '"' : "'";
        if (multiline === "basic" && line[index] === "\\") {
          index += 2;
          continue;
        }
        if (line[index] !== quote) {
          index += 1;
          continue;
        }
        let run = 1;
        while (line[index + run] === quote) run += 1;
        if (run >= 3) multiline = undefined;
        index += run;
        continue;
      }

      const character = line[index];
      if (character === "#") break;
      if (character === '"' || character === "'") {
        const quote = character;
        let run = 1;
        while (line[index + run] === quote) run += 1;
        if (run >= 3) {
          multiline = quote === '"' ? "basic" : "literal";
          index += 3;
          continue;
        }
        index += 1;
        let closed = false;
        while (index < line.length) {
          if (quote === '"' && line[index] === "\\") {
            index += 2;
            continue;
          }
          if (line[index] === quote) {
            index += 1;
            closed = true;
            break;
          }
          index += 1;
        }
        if (!closed) ambiguousToml(lineNumber, "a single-line string is unterminated");
        continue;
      }
      if (character === "[") arrayDepth += 1;
      else if (character === "]") {
        if (arrayDepth === 0) ambiguousToml(lineNumber, "an unmatched closing bracket was found");
        arrayDepth -= 1;
      }
      index += 1;
    }
    if (pendingArrayAssignment && lineIndex > pendingArrayAssignment.index) {
      pendingArrayAssignment.rawValue += `\n${line}`;
    }
    if (pendingArrayAssignment && arrayDepth === 0) pendingArrayAssignment = undefined;
  }

  if (multiline) {
    ambiguousToml(lines.length, `an unterminated multiline ${multiline} string was found`);
  }
  if (arrayDepth !== 0) ambiguousToml(lines.length, "an unterminated array was found");
  return { lines, headers, assignments };
}

function samePath(left, right) {
  return left.length === right.length && left.every((part, index) => part === right[index]);
}

function pathKey(path) {
  return path.join("\u0000");
}

// Consumers that need a trustworthy configuration decision, rather than only
// a table boundary, opt into this stricter pass. Duplicate declarations and
// multiline values have too much ambiguity for a security-sensitive status
// check to guess at their meaning.
export function assertUnambiguousTomlDocument(document) {
  const tables = new Set();
  for (const header of document.headers) {
    const key = pathKey(header.path);
    if (tables.has(key)) {
      throw new Error(`Refusing duplicate TOML table ${header.path.join(".")}.`);
    }
    tables.add(key);
  }
  const assignments = new Set();
  const assignmentPaths = [];
  for (const assignment of document.assignments) {
    if (assignment.kind === "multiline-string") {
      throw new Error(`Refusing multiline TOML assignment at line ${assignment.index + 1}.`);
    }
    const key = pathKey([...assignment.tablePath, ...assignment.key]);
    if (assignments.has(key)) {
      throw new Error(
        `Refusing duplicate TOML assignments for ${[...assignment.tablePath, ...assignment.key].join(".")}.`,
      );
    }
    const currentPath = [...assignment.tablePath, ...assignment.key];
    if (assignmentPaths.some((existingPath) =>
      (existingPath.length < currentPath.length && samePath(existingPath, currentPath.slice(0, existingPath.length))) ||
      (currentPath.length < existingPath.length && samePath(currentPath, existingPath.slice(0, currentPath.length))),
    )) {
      throw new Error(`Refusing colliding TOML assignment paths for ${currentPath.join(".")}.`);
    }
    if (assignment.kind === "other" && !trustedTomlOtherValue(assignment.rawValue)) {
      throw new Error(`Refusing untrusted TOML value at line ${assignment.index + 1}.`);
    }
    assignments.add(key);
    assignmentPaths.push(currentPath);
  }
}

export function tomlStringValue(document, tablePath, key) {
  const requestedPath = [...tablePath, key];
  const matches = document.assignments.filter(
    (assignment) =>
      samePath([...assignment.tablePath, ...assignment.key], requestedPath),
  );
  if (matches.length > 1) {
    throw new Error(`Refusing duplicate TOML assignments for ${[...tablePath, key].join(".")}.`);
  }
  if (matches.length === 0) return undefined;
  if (matches[0].kind !== "string") {
    throw new Error(`${[...tablePath, key].join(".")} must be a single-line TOML string.`);
  }
  return matches[0].value;
}

export function tomlBooleanValue(document, tablePath, key) {
  const requestedPath = [...tablePath, key];
  const matches = document.assignments.filter(
    (assignment) =>
      samePath([...assignment.tablePath, ...assignment.key], requestedPath),
  );
  if (matches.length > 1) {
    throw new Error(`Refusing duplicate TOML assignments for ${[...tablePath, key].join(".")}.`);
  }
  if (matches.length === 0) return undefined;
  if (matches[0].kind !== "boolean") {
    throw new Error(`${[...tablePath, key].join(".")} must be a TOML boolean.`);
  }
  return matches[0].value;
}
