// Cleans up Crowdin .lang export quirks before committing:
// 1. Restores intentionally empty keys that Crowdin drops.
// 2. Fixes the first-line header path to match the target's filename, not the source's.
// 3. Trims extra trailing blank lines added to partially translated files.
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..");
const SOURCE_FILE = "en_US.lang";

const ENTRY_RE = /^([^#\s][^=]*)=(.*)$/;
const HEADER_RE = /^(#.*\/)([^/]+\.lang)$/;

function detectEol(raw) {
  return raw.includes("\r\n") ? "\r\n" : "\n";
}

function splitLines(raw) {
  return raw.split(/\r\n|\n/);
}

function parseEntries(lines) {
  // Returns array of { index, key, value } for lines that are key=value entries.
  const entries = [];
  lines.forEach((line, index) => {
    const match = line.match(ENTRY_RE);
    if (match) {
      entries.push({ index, key: match[1], value: match[2] });
    }
  });
  return entries;
}

function countTrailingBlankLines(realLines) {
  let count = 0;
  for (let i = realLines.length - 1; i >= 0 && realLines[i] === ""; i--) {
    count++;
  }
  return count;
}

function main() {
  const sourcePath = path.join(ROOT, SOURCE_FILE);
  const sourceRaw = fs.readFileSync(sourcePath, "utf8");
  const sourceLines = splitLines(sourceRaw);
  const sourceEntries = parseEntries(sourceLines);
  const sourceTrailingNewline =
    sourceRaw.endsWith("\r\n") || sourceRaw.endsWith("\n");
  const sourceRealLines = sourceTrailingNewline
    ? sourceLines.slice(0, -1)
    : sourceLines;
  const sourceTrailingBlanks = countTrailingBlankLines(sourceRealLines);

  const emptyKeyPositions = sourceEntries
    .map((entry, i) => (entry.value === "" ? i : -1))
    .filter((i) => i !== -1);

  const targetFiles = fs
    .readdirSync(ROOT)
    .filter((f) => f.endsWith(".lang") && f !== SOURCE_FILE);

  let anyChanged = false;

  for (const fileName of targetFiles) {
    const filePath = path.join(ROOT, fileName);
    const raw = fs.readFileSync(filePath, "utf8");
    const eol = detectEol(raw);
    const lines = splitLines(raw);
    const trailingNewline = raw.endsWith("\r\n") || raw.endsWith("\n");

    let changed = false;
    const restoredKeys = [];

    // 1. Fix the header line if Crowdin replaced it with the source's own name.
    if (HEADER_RE.test(sourceLines[0]) && HEADER_RE.test(lines[0])) {
      const [, prefix] = sourceLines[0].match(HEADER_RE);
      const expectedHeader = `${prefix}${fileName}`;
      if (lines[0] !== expectedHeader) {
        lines[0] = expectedHeader;
        changed = true;
      }
    }

    // 2. Restore intentionally-empty keys that Crowdin dropped.
    let entries = parseEntries(lines);
    let presentKeys = new Set(entries.map((e) => e.key));

    for (const sourcePos of emptyKeyPositions) {
      const key = sourceEntries[sourcePos].key;
      if (presentKeys.has(key)) continue;

      // Walk outward from this key's position in the source file until we
      // find a neighboring key that actually exists in this target file -
      // handles sparsely-translated files where the immediate neighbor is
      // also missing, not just the very next one.
      let insertAt = null;

      for (let i = sourcePos - 1; i >= 0; i--) {
        const found = entries.find((e) => e.key === sourceEntries[i].key);
        if (found) {
          insertAt = found.index + 1;
          break;
        }
      }

      if (insertAt === null) {
        for (let i = sourcePos + 1; i < sourceEntries.length; i++) {
          const found = entries.find((e) => e.key === sourceEntries[i].key);
          if (found) {
            insertAt = found.index;
            break;
          }
        }
      }

      if (insertAt === null) {
        insertAt = lines.length; // fallback: nothing in this file to anchor to at all
      }

      lines.splice(insertAt, 0, `${key}=`);
      changed = true;
      restoredKeys.push(key);

      // Re-parse since indices shifted after the splice.
      entries = parseEntries(lines);
      presentKeys = new Set(entries.map((e) => e.key));
    }

    // 3. Trim excess trailing blank lines back down to match the source.
    const realLines = trailingNewline ? lines.slice(0, -1) : lines;
    let trimmedCount = 0;
    while (countTrailingBlankLines(realLines) > sourceTrailingBlanks) {
      realLines.pop();
      trimmedCount++;
    }
    if (trimmedCount > 0) changed = true;

    if (changed) {
      const out = realLines.join(eol) + (trailingNewline ? eol : "");
      fs.writeFileSync(filePath, out, "utf8");
      anyChanged = true;
      const parts = [];
      if (restoredKeys.length > 0) {
        parts.push(
          `restored ${restoredKeys.length} empty key(s): ${restoredKeys.join(", ")}`,
        );
      }
      if (trimmedCount > 0) {
        parts.push(`trimmed ${trimmedCount} trailing blank line(s)`);
      }
      console.log(`${fileName}: ${parts.join("; ") || "fixed header"}`);
    }
  }

  if (!anyChanged) {
    console.log("Nothing to fix in any target .lang file.");
  }
}

main();
