// Handles the /safe-term PR comment command: takes SAFE_TERM_QUERY (the
// term from the comment) via env var, finds flagged report entries whose
// matchedWords include it, adds it to safe-term-exceptions.json for every
// wordlist code implicated, then re-checks exactly those entries. Ones that
// come back fully clean get applied to the actual file and dropped from the
// report; ones still flagged for another reason stay, with fresh reasons.
//
// Writes _safe-term-result.json summarizing what happened, for the calling
// workflow to build its confirmation reply and rebuilt PR body from.
"use strict";

const fs = require("fs");
const path = require("path");
const {
  REPO_ROOT,
  resolveWordlistCode,
  checkContentIssues,
  loadSafeTermExceptions,
  saveSafeTermExceptions,
  loadLangMap,
  patchLangFile,
  patchJsonFile,
} = require("./lib/content-safety");

const REPORT_PATH = path.join(REPO_ROOT, "_flagged-report.json");
const RESULT_PATH = path.join(REPO_ROOT, "_safe-term-result.json");

function writeResult(result) {
  fs.writeFileSync(RESULT_PATH, JSON.stringify(result, null, 2), "utf8");
  console.log(JSON.stringify(result, null, 2));
}

async function main() {
  const term = (process.env.SAFE_TERM_QUERY || "").trim();
  if (!term) {
    writeResult({ status: "error", message: "No term provided." });
    process.exitCode = 1;
    return;
  }

  if (!fs.existsSync(REPORT_PATH)) {
    writeResult({
      status: "not-found",
      term,
      message: "No _flagged-report.json found on this branch.",
    });
    return;
  }

  const report = JSON.parse(fs.readFileSync(REPORT_PATH, "utf8"));
  const matchingIndexes = report
    .map((item, i) => ({ item, i }))
    .filter(
      ({ item }) =>
        item.reasons.includes("profanity-match") &&
        item.newValue.includes(term) &&
        item.matchedWords.some((w) => term.includes(w)),
    )
    .map(({ i }) => i);

  if (matchingIndexes.length === 0) {
    writeResult({
      status: "not-found",
      term,
      message: `No flagged profanity-match item in this PR has "${term}" in its matched words.`,
    });
    return;
  }

  const exceptions = loadSafeTermExceptions();
  const affectedCodes = new Set(
    matchingIndexes.map((i) => resolveWordlistCode(report[i].language)),
  );
  for (const code of affectedCodes) {
    if (!exceptions[code]) exceptions[code] = [];
    if (!exceptions[code].includes(term)) exceptions[code].push(term);
  }
  saveSafeTermExceptions(exceptions);

  const sourceRaw = fs.readFileSync(path.join(REPO_ROOT, "en_US.lang"), "utf8");
  const sourceLangMap = loadLangMap(sourceRaw);
  const websiteEnPath = path.join(REPO_ROOT, "website", "en.json");
  const sourceWebsiteMap = fs.existsSync(websiteEnPath)
    ? JSON.parse(fs.readFileSync(websiteEnPath, "utf8"))
    : {};

  const resolved = [];
  const stillFlagged = [];
  const cleanUpdatesByFile = new Map();

  for (let i = 0; i < report.length; i++) {
    const item = report[i];
    if (!matchingIndexes.includes(i)) {
      stillFlagged.push(item);
      continue;
    }

    const isWebsite = item.file.startsWith("website/");
    const englishSourceValue = isWebsite
      ? sourceWebsiteMap[item.key]
      : sourceLangMap.get(item.key);

    const { flagged, matches, reasons } = await checkContentIssues(
      item.newValue,
      item.language,
      englishSourceValue,
      exceptions,
    );

    if (!flagged) {
      resolved.push(item);
      if (!cleanUpdatesByFile.has(item.file)) {
        cleanUpdatesByFile.set(item.file, new Map());
      }
      cleanUpdatesByFile.get(item.file).set(item.key, item.newValue);
    } else {
      stillFlagged.push({ ...item, matchedWords: matches, reasons });
    }
  }

  for (const [file, updates] of cleanUpdatesByFile) {
    const filePath = path.join(REPO_ROOT, file);
    const raw = fs.readFileSync(filePath, "utf8");
    const patched = file.endsWith(".json")
      ? patchJsonFile(raw, updates)
      : patchLangFile(raw, updates, sourceRaw, file);
    fs.writeFileSync(filePath, patched, "utf8");
  }

  if (stillFlagged.length === 0) {
    // Nothing left to review - remove the report entirely rather than
    // leaving a stale "[]" file committed on the branch.
    fs.rmSync(REPORT_PATH, { force: true });
  } else {
    fs.writeFileSync(
      REPORT_PATH,
      JSON.stringify(stillFlagged, null, 2),
      "utf8",
    );
  }

  writeResult({
    status: "resolved",
    term,
    affectedCodes: [...affectedCodes],
    resolvedItems: resolved.map((i) => ({
      file: i.file,
      key: i.key,
      language: i.language,
    })),
    remainingCount: stillFlagged.length,
  });
}

main().catch((err) => {
  console.error(err);
  writeResult({ status: "error", message: String(err) });
  process.exitCode = 1;
});
