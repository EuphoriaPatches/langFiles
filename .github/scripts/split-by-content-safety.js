// Compares freshly-downloaded Crowdin translations (in _new/) against the
// current committed versions, and splits the changed keys into two groups:
//
// - "clean" changes are patched directly onto the existing files in place
//   (the caller commits these straight to the target branch).
// - "flagged" changes (profanity, phishing, injection, spam - see
//   lib/content-safety.js) are written to _flagged-report.json instead of
//   being applied, so they can go through the PR review path applied by
//   apply-flagged-report.js.
//
// Requires: `PROFANITY_REPO_TOKEN` environment variable.
"use strict";

const fs = require("fs");
const path = require("path");
const {
  REPO_ROOT,
  checkContentIssues,
  loadSafeTermExceptions,
  splitLines,
  loadLangMap,
  patchLangFile,
  patchJsonFile,
  loadSourceKeyOrder,
  buildLangFileFromTemplate,
  ENTRY_RE,
} = require("./lib/content-safety");

const NEW_LANG_DIR = path.join(REPO_ROOT, "_new");
const NEW_WEBSITE_DIR = path.join(REPO_ROOT, "_new", "website");
const REPORT_PATH = path.join(REPO_ROOT, "_flagged-report.json");

async function main() {
  const sourceRaw = fs.readFileSync(path.join(REPO_ROOT, "en_US.lang"), "utf8");
  const sourceKeyOrder = loadSourceKeyOrder(sourceRaw);
  const sourceLangMap = loadLangMap(sourceRaw);
  const exceptions = loadSafeTermExceptions();

  const websiteEnPath = path.join(REPO_ROOT, "website", "en.json");
  const sourceWebsiteMap = fs.existsSync(websiteEnPath)
    ? JSON.parse(fs.readFileSync(websiteEnPath, "utf8"))
    : {};

  const flaggedReport = [];

  if (fs.existsSync(NEW_LANG_DIR)) {
    const newLangFiles = fs
      .readdirSync(NEW_LANG_DIR)
      .filter((f) => f.endsWith(".lang"));

    for (const fileName of newLangFiles) {
      const langId = fileName.replace(/\.lang$/, "");
      const oldPath = path.join(REPO_ROOT, fileName);
      const newPath = path.join(NEW_LANG_DIR, fileName);
      const isNewFile = !fs.existsSync(oldPath);

      // If the old file doesn't exist, we treat it as an empty file. For new languages which did not exist before.
      const oldRaw = isNewFile ? "" : fs.readFileSync(oldPath, "utf8");
      const newRaw = fs.readFileSync(newPath, "utf8");
      const oldMap = loadLangMap(oldRaw);
      const newMap = loadLangMap(newRaw);

      const cleanUpdates = new Map();
      for (const [key, newValue] of newMap) {
        if (oldMap.get(key) === newValue) continue;
        const { flagged, matches, reasons } = await checkContentIssues(
          newValue,
          langId,
          sourceLangMap.get(key),
          exceptions,
        );
        if (flagged) {
          flaggedReport.push({
            file: fileName,
            key,
            language: langId,
            oldValue: oldMap.get(key) ?? "",
            newValue,
            matchedWords: matches,
            reasons,
          });
        } else {
          cleanUpdates.set(key, newValue);
        }
      }

      if (isNewFile) {
        // Build from the source's own structure to preserve new lines, comments, and key order.
        fs.writeFileSync(
          oldPath,
          buildLangFileFromTemplate(sourceRaw, cleanUpdates, fileName),
          "utf8",
        );
        console.log(
          `${fileName}: created new language file (${cleanUpdates.size} clean update(s))`,
        );
      } else if (cleanUpdates.size > 0) {
        fs.writeFileSync(
          oldPath,
          patchLangFile(oldRaw, cleanUpdates, sourceKeyOrder),
          "utf8",
        );
        console.log(
          `${fileName}: applied ${cleanUpdates.size} clean update(s)`,
        );
      }
    }
  }

  if (fs.existsSync(NEW_WEBSITE_DIR)) {
    const newJsonFiles = fs
      .readdirSync(NEW_WEBSITE_DIR)
      .filter((f) => f.endsWith(".json"));

    for (const fileName of newJsonFiles) {
      const langId = fileName.replace(/\.json$/, "");
      const relFile = `website/${fileName}`;
      const oldPath = path.join(REPO_ROOT, "website", fileName);
      const newPath = path.join(NEW_WEBSITE_DIR, fileName);

      const oldRaw = fs.existsSync(oldPath)
        ? fs.readFileSync(oldPath, "utf8")
        : "{}";
      const newRaw = fs.readFileSync(newPath, "utf8");
      const oldObj = JSON.parse(oldRaw);
      const newObj = JSON.parse(newRaw);

      const cleanUpdates = new Map();
      for (const [key, newValue] of Object.entries(newObj)) {
        if (typeof newValue !== "string") continue;
        if (oldObj[key] === newValue) continue;
        const { flagged, matches, reasons } = await checkContentIssues(
          newValue,
          langId,
          sourceWebsiteMap[key],
          exceptions,
        );
        if (flagged) {
          flaggedReport.push({
            file: relFile,
            key,
            language: langId,
            oldValue: oldObj[key] ?? "",
            newValue,
            matchedWords: matches,
            reasons,
          });
        } else {
          cleanUpdates.set(key, newValue);
        }
      }

      if (cleanUpdates.size > 0) {
        fs.writeFileSync(oldPath, patchJsonFile(oldRaw, cleanUpdates), "utf8");
        console.log(`${relFile}: applied ${cleanUpdates.size} clean update(s)`);
      }
    }
  }

  // Clean up the staging directory now to prevent commit issues.
  fs.rmSync(NEW_LANG_DIR, { recursive: true, force: true });

  fs.writeFileSync(REPORT_PATH, JSON.stringify(flaggedReport, null, 2), "utf8");

  if (flaggedReport.length === 0) {
    console.log("No flagged content this run.");
  } else {
    console.log(`${flaggedReport.length} flagged item(s):`);
    for (const item of flaggedReport) {
      console.log(
        `  ${item.file} [${item.key}] (${item.language}) [${item.reasons.join(", ")}] matched: ${item.matchedWords.join(", ")}`,
      );
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
