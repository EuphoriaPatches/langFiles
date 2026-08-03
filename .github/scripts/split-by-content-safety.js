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
// Requires: `PROFANITY_REPO_TOKEN` environment variable. `CROWDIN_TOKEN` /
// `CROWDIN_PROJECT_ID_LANG` are optional - without them, punctuation fixes
// (see pushPunctuationCorrections) still get committed locally but aren't
// pushed back up to Crowdin. Set `DRY_RUN=true` to log what would be pushed
// instead of calling the Crowdin API at all (see the workflow's
// prevent_crowdin_uploads input).
"use strict";

const fs = require("fs");
const path = require("path");
const {
  REPO_ROOT,
  checkContentIssues,
  normalizeFullWidthPeriods,
  loadSafeTermExceptions,
  splitLines,
  loadLangMap,
  mergeLangUpdates,
  hasRealTranslation,
  patchJsonFile,
  buildLangFileFromTemplate,
  ENTRY_RE,
} = require("./lib/content-safety");
const {
  pushAndApproveTranslation,
  getProjectLanguageIds,
  resolveCrowdinLanguageId,
  resolveStringId,
} = require("./lib/crowdin-api");

const NEW_LANG_DIR = path.join(REPO_ROOT, "_new");
const NEW_WEBSITE_DIR = path.join(REPO_ROOT, "_new", "website");
const REPORT_PATH = path.join(REPO_ROOT, "_flagged-report.json");

// Pushes punctuation-normalized values back up to Crowdin so the correction
// sticks - otherwise Crowdin still holds the translator's original
// full-width period and every future sync would "fix" (and re-diff) the
// same key again. Best-effort: a translator's own subsequent edit in
// Crowdin should never be blocked by this failing, so failures are logged
// and skipped rather than thrown.
async function pushPunctuationCorrections(corrections) {
  if (process.env.DRY_RUN === "true") {
    for (const { key, language, value } of corrections) {
      console.log(`[DRY RUN] would push punctuation fix to Crowdin: [${key}] (${language}): ${JSON.stringify(value)}`);
    }
    return;
  }

  const token = process.env.CROWDIN_TOKEN;
  const projectId = process.env.CROWDIN_PROJECT_ID_LANG;
  if (!token || !projectId) {
    console.warn(
      `WARNING: ${corrections.length} punctuation correction(s) found but CROWDIN_TOKEN/CROWDIN_PROJECT_ID_LANG are not set - skipping Crowdin push.`,
    );
    return;
  }

  const projectLanguageIds = await getProjectLanguageIds(token, projectId);
  const stringIdCache = new Map();
  const languageIdCache = new Map();

  for (const { key, language, value } of corrections) {
    if (!languageIdCache.has(language)) {
      languageIdCache.set(language, resolveCrowdinLanguageId(language, projectLanguageIds));
    }
    const languageId = languageIdCache.get(language);
    if (!languageId) {
      console.warn(`WARNING: could not resolve a Crowdin language ID for "${language}" - skipping punctuation fix for [${key}].`);
      continue;
    }

    try {
      const stringId = await resolveStringId(token, projectId, key, stringIdCache);
      if (!stringId) {
        console.warn(`WARNING: no Crowdin string found for identifier "${key}" - skipping punctuation fix.`);
        continue;
      }
      await pushAndApproveTranslation(token, projectId, stringId, languageId, value);
      console.log(`Pushed punctuation fix to Crowdin: [${key}] (${language})`);
    } catch (err) {
      console.warn(`WARNING: failed to push punctuation fix for [${key}] (${language}): ${err.message}`);
    }
  }
}

async function main() {
  const sourceRaw = fs.readFileSync(path.join(REPO_ROOT, "en_US.lang"), "utf8");
  const sourceLangMap = loadLangMap(sourceRaw);
  const exceptions = loadSafeTermExceptions();

  const websiteEnPath = path.join(REPO_ROOT, "website", "en.json");
  const sourceWebsiteMap = fs.existsSync(websiteEnPath)
    ? JSON.parse(fs.readFileSync(websiteEnPath, "utf8"))
    : {};

  const flaggedReport = [];
  // Punctuation fixes (see normalizeFullWidthPeriods) need pushing back to
  // Crowdin itself, not just committed here - otherwise the next export
  // still has the translator's original full-width period and we'd "fix"
  // the same key over and over on every sync.
  const punctuationCorrections = []; // { key, language, value }

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
      for (const [key, rawNewValue] of newMap) {
        const newValue = normalizeFullWidthPeriods(rawNewValue);
        if (newValue !== rawNewValue) {
          punctuationCorrections.push({ key, language: langId, value: newValue });
        }
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
            existedBefore: oldMap.has(key),
            newValue,
            matchedWords: matches,
            reasons,
          });
        } else {
          cleanUpdates.set(key, newValue);
        }
      }

      // Crowdin now exports only actual translations (skip_untranslated_strings),
      // so a key that's no longer in the export is either newly-untranslated
      // (was reverted/invalidated) or was never translated at all. Either way
      // it should be dropped from the committed file rather than left
      // pinned to its last-known value - dropping is always "clean" since it
      // removes text rather than introducing new content, so no content
      // check is needed here.
      let removedCount = 0;
      for (const key of oldMap.keys()) {
        if (newMap.has(key)) continue; // handled above
        if (!sourceLangMap.has(key)) continue; // stale key, template rebuild drops it anyway
        if (sourceLangMap.get(key) === "") continue; // intentionally-empty key, always kept
        cleanUpdates.set(key, undefined);
        removedCount++;
      }

      if (isNewFile) {
        // Don't create a file for a language with nothing translated yet -
        // buildLangFileFromTemplate would still emit the header, comments,
        // and always-empty placeholder keys, producing a content-free
        // skeleton file. Wait for at least one real translation.
        if (cleanUpdates.size > 0) {
          // Build from the source's own structure to preserve new lines, comments, and key order.
          fs.writeFileSync(
            oldPath,
            buildLangFileFromTemplate(sourceRaw, cleanUpdates, fileName),
            "utf8",
          );
          console.log(
            `${fileName}: created new language file (${cleanUpdates.size} clean update(s))`,
          );
        } else {
          console.log(
            `${fileName}: skipped - no translations yet for this new language.`,
          );
        }
      } else if (cleanUpdates.size > 0) {
        const mergedMap = mergeLangUpdates(oldRaw, cleanUpdates);
        if (hasRealTranslation(mergedMap, sourceLangMap)) {
          fs.writeFileSync(
            oldPath,
            buildLangFileFromTemplate(sourceRaw, mergedMap, fileName),
            "utf8",
          );
          const removedSuffix =
            removedCount > 0 ? `, dropped ${removedCount} untranslated key(s)` : "";
          console.log(
            `${fileName}: applied ${cleanUpdates.size - removedCount} clean update(s)${removedSuffix}`,
          );
        } else {
          fs.rmSync(oldPath);
          console.log(
            `${fileName}: removed - no translations remain for this language.`,
          );
        }
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
            existedBefore: Object.prototype.hasOwnProperty.call(oldObj, key),
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

  if (punctuationCorrections.length > 0) {
    await pushPunctuationCorrections(punctuationCorrections);
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
