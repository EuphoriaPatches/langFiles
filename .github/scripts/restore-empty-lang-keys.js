// After Crowdin downloads translations, any key whose *source* value in
// en_US.lang is empty gets dropped from exported files. These empty-value keys are
// intentional, so this script restores any of them that Crowdin's
// export dropped.
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..");
const SOURCE_FILE = "en_US.lang";

const ENTRY_RE = /^([^#\s][^=]*)=(.*)$/;

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

function main() {
  const sourcePath = path.join(ROOT, SOURCE_FILE);
  const sourceRaw = fs.readFileSync(sourcePath, "utf8");
  const sourceLines = splitLines(sourceRaw);
  const sourceEntries = parseEntries(sourceLines);

  const emptyKeyPositions = sourceEntries
    .map((entry, i) => (entry.value === "" ? i : -1))
    .filter((i) => i !== -1);

  if (emptyKeyPositions.length === 0) {
    console.log("No empty-valued source keys found - nothing to restore.");
    return;
  }

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

    let entries = parseEntries(lines);
    let presentKeys = new Set(entries.map((e) => e.key));

    let changed = false;
    const missing = [];

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
      missing.push(key);

      // Re-parse since indices shifted after the splice.
      entries = parseEntries(lines);
      presentKeys = new Set(entries.map((e) => e.key));
    }

    if (changed) {
      const out = lines.join(eol) + (trailingNewline ? eol : "");
      fs.writeFileSync(filePath, out, "utf8");
      anyChanged = true;
      console.log(
        `Restored ${missing.length} empty key(s) in ${fileName}: ${missing.join(", ")}`,
      );
    }
  }

  if (!anyChanged) {
    console.log(
      "All target files already had every empty-valued key - nothing to restore.",
    );
  }
}

main();
