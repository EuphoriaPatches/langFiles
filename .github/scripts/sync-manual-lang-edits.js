// Handles the "version bump" workflow: when en_US.lang and other *.lang
// files are hand-edited together in the same push then feeds those changes to Crowdin directly
// so that the Crowdin project is kept in sync with the repo's current state.
"use strict";

const { execFileSync } = require("child_process");
const path = require("path");
const { REPO_ROOT, loadLangMap } = require("./lib/content-safety");
const {
  isDuplicateTranslationError,
  findMatchingTranslation,
  getProjectLanguageIds,
  resolveCrowdinLanguageId,
  resolveStringId,
  crowdinRequest,
} = require("./lib/crowdin-api");

const ZERO_SHA = "0000000000000000000000000000000000000000";

function gitShow(sha, filePath) {
  try {
    return execFileSync("git", ["show", `${sha}:${filePath}`], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      maxBuffer: 1024 * 1024 * 50,
    });
  } catch {
    return null; // file didn't exist at that commit
  }
}

function listLangFiles() {
  const { readdirSync } = require("fs");
  return readdirSync(REPO_ROOT).filter(
    (f) => f.endsWith(".lang") && f !== "en_US.lang",
  );
}

function changedKeys(oldRaw, newRaw) {
  const oldMap = oldRaw === null ? new Map() : loadLangMap(oldRaw);
  const newMap = newRaw === null ? new Map() : loadLangMap(newRaw);
  const changed = new Map();
  for (const [key, value] of newMap) {
    if (oldMap.get(key) !== value) changed.set(key, value);
  }
  return changed;
}

async function main() {
  const beforeSha = process.env.BEFORE_SHA;
  const afterSha = process.env.AFTER_SHA;
  const token = process.env.CROWDIN_TOKEN;
  const projectId = process.env.CROWDIN_PROJECT_ID_LANG;

  if (!beforeSha || beforeSha === ZERO_SHA) {
    console.log("No prior commit to diff against (first push or force-push) - skipping.");
    return;
  }
  if (!token || !projectId) {
    throw new Error("CROWDIN_TOKEN / CROWDIN_PROJECT_ID_LANG env vars are required.");
  }

  const oldSource = gitShow(beforeSha, "en_US.lang");
  const newSource = gitShow(afterSha, "en_US.lang");
  const sourceChanges = changedKeys(oldSource, newSource);

  if (sourceChanges.size === 0) {
    console.log("No key changes in en_US.lang for this push - nothing to do.");
    return;
  }

  const projectLanguageIds = await getProjectLanguageIds(token, projectId);
  const stringIdCache = new Map();
  let pushedCount = 0;

  for (const fileName of listLangFiles()) {
    const langId = fileName.replace(/\.lang$/, "");
    const languageId = resolveCrowdinLanguageId(langId, projectLanguageIds);
    if (!languageId) {
      console.warn(`WARNING: could not resolve a Crowdin language ID for "${langId}" (no match in project languages: ${projectLanguageIds.join(", ")}) - skipping ${fileName}.`);
      continue;
    }
    const oldRaw = gitShow(beforeSha, fileName);
    const newRaw = gitShow(afterSha, fileName);
    if (newRaw === null) continue; // file doesn't exist at this commit

    const oldMap = oldRaw === null ? new Map() : loadLangMap(oldRaw);
    const newMap = loadLangMap(newRaw);

    for (const key of sourceChanges.keys()) {
      if (!newMap.has(key)) continue;
      const newValue = newMap.get(key);
      // Only act when this language's value for the key *also* changed in
      // this same push - that's the "kept in sync by hand" signal. A key
      // that changed in the source but not here is a real content change
      // that should still go through the normal retranslation flow.
      if (oldMap.get(key) === newValue) continue;

      if (process.env.DRY_RUN === "true") {
        console.log(`[DRY RUN] would sync ${fileName} [${key}] -> Crowdin (${languageId}): ${JSON.stringify(newValue)}`);
        pushedCount++;
        continue;
      }

      const stringId = await resolveStringId(token, projectId, key, stringIdCache);
      if (!stringId) {
        console.warn(`WARNING: no Crowdin string found for identifier "${key}" - skipping ${fileName}.`);
        continue;
      }

      try {
        let translationId;
        try {
          const translation = await crowdinRequest(
            token,
            "POST",
            `/projects/${projectId}/translations`,
            {
              stringId,
              languageId,
              text: newValue,
            },
          );
          translationId = translation.data.id;
        } catch (err) {
          if (!isDuplicateTranslationError(err)) throw err;
          const existing = await findMatchingTranslation(
            token,
            projectId,
            stringId,
            languageId,
            newValue,
          );
          if (!existing) throw err;
          translationId = existing.id;
        }
        await crowdinRequest(
          token,
          "POST",
          `/projects/${projectId}/approvals`,
          {
            translationId,
          },
        );
        console.log(
          `Synced ${fileName} [${key}] -> Crowdin (${languageId}), approved.`,
        );
        pushedCount++;
      } catch (err) {
        console.warn(
          `WARNING: failed to sync ${fileName} [${key}]: ${err.message}`,
        );
      }
    }
  }

  console.log(`Done. Pushed ${pushedCount} synchronized translation(s) to Crowdin.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
