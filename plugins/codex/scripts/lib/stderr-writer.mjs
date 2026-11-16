// #4212: the one place the plugin scripts write to stderr.
//
// Paths, working directories, state fields and error messages can come from other
// workspace roots or from files nobody trusts. Written raw they can carry terminal
// escapes (ESC, C1 such as U+009B, bidi and format characters) and line breaks that
// forge a second message. So stderr is written only through stderrf: the literal text
// of the template is the formatter's own and goes through as written; every
// interpolated value is an untrusted fragment and is escaped completely, line feeds
// and carriage returns included. Nothing else in plugins/codex/scripts may call
// process.stderr.write or console.error/warn (tests/runtime.test.mjs enforces it).

const UNSAFE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

function unit(n) {
  return `\\u${n.toString(16).padStart(4, "0")}`;
}

function escapeChar(ch) {
  const cp = ch.codePointAt(0);
  if (cp <= 0xffff) return unit(cp);
  // JSON and JS escapes are UTF-16 units: a code point above U+FFFF is a surrogate pair.
  const v = cp - 0x10000;
  return unit(0xd800 + (v >> 10)) + unit(0xdc00 + (v & 0x3ff));
}

// An untrusted fragment: every control, format and line-separator character escaped, LF too.
export function untrusted(value) {
  return String(value).replace(UNSAFE, escapeChar);
}

// Formatter-built text that may keep its own newlines (a pretty-printed JSON report: JSON
// already escapes the line feeds inside strings, so the ones left are the formatter's).
export function escapeKeepingNewlines(text) {
  return String(text).replace(UNSAFE, (ch) => (ch === "\n" ? ch : escapeChar(ch)));
}

// stderrf`text ${fragment} text\n`: literals raw, values untrusted. Returns the string.
export function formatStderr(strings, ...values) {
  let out = strings[0];
  for (let i = 0; i < values.length; i += 1) out += untrusted(values[i]) + strings[i + 1];
  return out;
}

export function stderrf(strings, ...values) {
  process.stderr.write(formatStderr(strings, ...values));
}

// The guard under the writer. lib/fenced-lock.mjs is a byte-equal vendored copy of the factory-core
// file (fenced-lock.source.json) and keeps its own process.stderr.write calls, with directory names in
// them. Whatever reaches process.stderr.write in a process that loaded this module is therefore
// sanitized once more at the stream: every unsafe character escaped, and a line feed kept only as the
// last character of a chunk, so a fragment inside a line can never start a second one. stderrf output
// is one line per call and passes unchanged.
export function sanitizeChunk(chunk) {
  const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
  const end = text.endsWith("\n") ? "\n" : "";
  return untrusted(end ? text.slice(0, -1) : text) + end;
}

const GUARDED = Symbol.for("codex-plugin.stderr-guard");
if (!process.stderr[GUARDED]) {
  const write = process.stderr.write;
  process.stderr.write = function guardedWrite(chunk, ...rest) {
    return write.call(this, typeof chunk === "string" || ArrayBuffer.isView(chunk) ? sanitizeChunk(chunk) : chunk, ...rest);
  };
  Object.defineProperty(process.stderr, GUARDED, { value: true });
}

// Constant program text only (help overviews): written as is. Never pass anything read from disk,
// argv or the environment.
export function stderrFixed(text) {
  for (const line of String(text).split("\n")) {
    if (line !== "" || text.endsWith("\n")) process.stderr.write(`${line}\n`);
  }
}

// An error whose message is several formatter-built lines. The caller guarantees that each
// element is one line (no fragment of it contains a line feed: build the lines from fields
// already cleaned with plainField). The top-level handler prints the lines one by one, each
// escaped like any other fragment; an ordinary Error message is printed as one escaped line.
export class MultilineError extends Error {
  constructor(lines) {
    super(lines.join("\n"));
    this.lines = lines;
  }
}

export function reportError(error) {
  const lines = error instanceof MultilineError ? error.lines : [error instanceof Error ? error.message : String(error)];
  for (const line of lines) stderrf`${line}\n`;
}
