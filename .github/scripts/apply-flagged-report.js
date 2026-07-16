// Applies the flagged updates recorded by split-by-content-safety.js onto the
// current files (which by this point already have the clean changes
// committed). Run this only on the localization branch, after the clean
// commit has landed on the target branch.
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..");
const REPORT_PATH = path.join(ROOT, "_flagged-report.json");

const ENTRY_RE = /^([^#\s][^=]*)=(.*)$/;

function splitLines(raw) {
  return raw.split(/\r\n|\n/);
}

function detectEol(raw) {
  return raw.includes("\r\n") ? "\r\n" : "\n";
}

function parseLangEntries(lines) {
  const map = new Map();
  lines.forEach((line, index) => {
    const m = line.match(ENTRY_RE);
    if (m) map.set(m[1], { value: m[2], index });
  });
  return map;
}

function patchLangFile(oldRaw, updates, sourceKeyOrder) {
  const eol = detectEol(oldRaw);
  const trailingNewline = oldRaw.endsWith("\r\n") || oldRaw.endsWith("\n");
  const lines = splitLines(oldRaw);
  let entries = parseLangEntries(lines);

  for (const [key, value] of updates) {
    const existing = entries.get(key);
    if (existing) {
      lines[existing.index] = `${key}=${value}`;
    } else {
      const srcIdx = sourceKeyOrder.indexOf(key);
      let insertAt = null;
      if (srcIdx !== -1) {
        for (let i = srcIdx - 1; i >= 0 && insertAt === null; i--) {
          const anchor = entries.get(sourceKeyOrder[i]);
          if (anchor) insertAt = anchor.index + 1;
        }
        for (let i = srcIdx + 1; i < sourceKeyOrder.length && insertAt === null; i++) {
          const anchor = entries.get(sourceKeyOrder[i]);
          if (anchor) insertAt = anchor.index;
        }
      }
      if (insertAt === null) insertAt = lines.length;
      lines.splice(insertAt, 0, `${key}=${value}`);
    }
    entries = parseLangEntries(lines);
  }

  const realLines = trailingNewline ? lines.slice(0, -1) : lines;
  return realLines.join(eol) + (trailingNewline ? eol : "");
}

function patchJsonFile(oldRaw, updates) {
  const obj = JSON.parse(oldRaw);
  for (const [key, value] of updates) obj[key] = value;
  return JSON.stringify(obj, null, 2) + "\n";
}

function main() {
  if (!fs.existsSync(REPORT_PATH)) {
    console.log("No flagged report found - nothing to apply.");
    return;
  }

  const report = JSON.parse(fs.readFileSync(REPORT_PATH, "utf8"));
  if (report.length === 0) {
    console.log("Flagged report is empty - nothing to apply.");
    return;
  }

  const sourceRaw = fs.readFileSync(path.join(ROOT, "en_US.lang"), "utf8");
  const sourceKeyOrder = [];
  splitLines(sourceRaw).forEach((line) => {
    const m = line.match(ENTRY_RE);
    if (m) sourceKeyOrder.push(m[1]);
  });

  const byFile = new Map();
  for (const item of report) {
    if (!byFile.has(item.file)) byFile.set(item.file, new Map());
    byFile.get(item.file).set(item.key, item.newValue);
  }

  for (const [file, updates] of byFile) {
    const filePath = path.join(ROOT, file);
    const raw = fs.readFileSync(filePath, "utf8");
    const patched = file.endsWith(".json")
      ? patchJsonFile(raw, updates)
      : patchLangFile(raw, updates, sourceKeyOrder);
    fs.writeFileSync(filePath, patched, "utf8");
    console.log(`Applied ${updates.size} flagged update(s) to ${file}`);
  }
}

main();
