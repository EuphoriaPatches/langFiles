// Handles the "version bump" workflow: when en_US.lang and other *.lang
// files are hand-edited together in the same push (e.g. a global find/
// replace bumping a version number across every language at once), the
// normal pipeline would otherwise let Crowdin's own "source changed"
// invalidation reset those translations to English until a translator
// redoes them - even though the correct translation is already sitting
// right there in the repo.
//
// For each key that changed in en_US.lang in this push, checks whether
// each other lang file *also* changed that same key in the same push. If
// so, that's treated as a deliberate synchronized edit, and the new value
// is pushed directly to Crowdin as the current, approved translation via
// the string-translations API - bypassing the "needs retranslation" state
// entirely for exactly those keys. Any source key that changed *without* a
// corresponding change elsewhere is left alone, since that's a real content
// edit that should still flow through the normal reset-and-retranslate path.
"use strict";

const { execFileSync } = require("child_process");
const path = require("path");
const { REPO_ROOT, loadLangMap, resolveWordlistCode } = require("./lib/content-safety");

const CROWDIN_API = "https://api.crowdin.com/api/v2";
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

async function crowdinRequest(token, method, urlPath, body) {
  const res = await fetch(`${CROWDIN_API}${urlPath}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(
      `Crowdin API ${method} ${urlPath} failed (${res.status}): ${JSON.stringify(json)}`,
    );
  }
  return json;
}

async function resolveStringId(token, projectId, key, cache) {
  if (cache.has(key)) return cache.get(key);
  const result = await crowdinRequest(
    token,
    "GET",
    `/projects/${projectId}/strings?filter=${encodeURIComponent(key)}&scope=identifier&limit=50`,
  );
  const match = (result.data || []).find((item) => item.data.identifier === key);
  const id = match ? match.data.id : null;
  cache.set(key, id);
  return id;
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

  const stringIdCache = new Map();
  let pushedCount = 0;

  for (const fileName of listLangFiles()) {
    const langId = fileName.replace(/\.lang$/, "");
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

      const languageId = resolveWordlistCode(langId);

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
        const translation = await crowdinRequest(token, "POST", `/projects/${projectId}/translations`, {
          stringId,
          languageId,
          text: newValue,
        });
        await crowdinRequest(token, "POST", `/projects/${projectId}/approvals`, {
          translationId: translation.data.id,
        });
        console.log(`Synced ${fileName} [${key}] -> Crowdin (${languageId}), approved.`);
        pushedCount++;
      } catch (err) {
        console.warn(`WARNING: failed to sync ${fileName} [${key}]: ${err.message}`);
      }
    }
  }

  console.log(`Done. Pushed ${pushedCount} synchronized translation(s) to Crowdin.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
