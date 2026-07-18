// Applies the flagged updates recorded by split-by-content-safety.js onto the
// current files (which by this point already have the clean changes
// committed). Run this only on the localization branch, after the clean
// commit has landed on the target branch.
"use strict";

const fs = require("fs");
const path = require("path");
const {
  REPO_ROOT,
  patchLangFile,
  patchJsonFile,
} = require("./lib/content-safety");

const REPORT_PATH = path.join(REPO_ROOT, "_flagged-report.json");

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

  const sourceRaw = fs.readFileSync(
    path.join(REPO_ROOT, "en_US.lang"),
    "utf8",
  );

  const byFile = new Map();
  for (const item of report) {
    if (!byFile.has(item.file)) byFile.set(item.file, new Map());
    byFile.get(item.file).set(item.key, item.newValue);
  }

  for (const [file, updates] of byFile) {
    const filePath = path.join(REPO_ROOT, file);
    const raw = fs.readFileSync(filePath, "utf8");
    const patched = file.endsWith(".json")
      ? patchJsonFile(raw, updates)
      : patchLangFile(raw, updates, sourceRaw, file);
    fs.writeFileSync(filePath, patched, "utf8");
    console.log(`Applied ${updates.size} flagged update(s) to ${file}`);
  }
}

main();
