// Handles the "version bump" workflow: when en_US.lang and other *.lang
// files are hand-edited together in the same push then feeds those changes to Crowdin directly
// so that the Crowdin project is kept in sync with the repo's current state.
//
// Run with --snapshot (before upload_sources, which clears Crowdin approvals)
// to just record current approval status; the normal run replays it via APPROVAL_SNAPSHOT_PATH.
"use strict";

const fs = require("fs");
const { execFileSync } = require("child_process");
const { REPO_ROOT, loadLangMap } = require("./lib/content-safety");
const {
  pushTranslationMirroringApproval,
  findMatchingTranslation,
  isTranslationApproved,
  getProjectLanguageIds,
  resolveCrowdinLanguageId,
  resolveStringId,
} = require("./lib/crowdin-api");

const ZERO_SHA = "0000000000000000000000000000000000000000";
const SNAPSHOT_MODE = process.argv.includes("--snapshot");
const SNAPSHOT_PATH = `${REPO_ROOT}/crowdin-approval-snapshot.json`;

function writeSnapshot(entries, ok = true) {
  fs.writeFileSync(SNAPSHOT_PATH, JSON.stringify({ ok, entries }, null, 2), "utf8");
}

// Loads a --snapshot file into a `"file key" -> approved` Map, or null when
// there's no usable one (caller then checks approval live).
function loadSnapshot() {
  const p = process.env.APPROVAL_SNAPSHOT_PATH;
  if (!p) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(p, "utf8"));
    if (!parsed || parsed.ok === false) return null;
    const map = new Map();
    for (const e of parsed.entries || []) map.set(`${e.fileName} ${e.key}`, e.approved);
    console.log(`Loaded approval snapshot (${map.size} translation(s)).`);
    return map;
  } catch (err) {
    console.warn(`WARNING: could not read approval snapshot at ${p}: ${err.message}`);
    return null;
  }
}

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
    if (SNAPSHOT_MODE) writeSnapshot([]);
    return;
  }
  if (!token || !projectId) {
    if (SNAPSHOT_MODE) {
      console.warn("WARNING: CROWDIN_TOKEN / CROWDIN_PROJECT_ID_LANG not set - writing an unusable snapshot.");
      writeSnapshot([], false);
      return;
    }
    throw new Error("CROWDIN_TOKEN / CROWDIN_PROJECT_ID_LANG env vars are required.");
  }

  const oldSource = gitShow(beforeSha, "en_US.lang");
  const newSource = gitShow(afterSha, "en_US.lang");
  const sourceChanges = changedKeys(oldSource, newSource);

  if (sourceChanges.size === 0) {
    console.log("No key changes in en_US.lang for this push - nothing to do.");
    if (SNAPSHOT_MODE) writeSnapshot([]);
    return;
  }

  const forceNoApproval = process.env.CROWDIN_SKIP_APPROVAL === "true";
  const snapshot = SNAPSHOT_MODE ? null : loadSnapshot();
  if (!SNAPSHOT_MODE && !snapshot && !forceNoApproval) {
    console.warn("WARNING: no approval snapshot - approval status read live, which is unreliable once the source strings changed this run.");
  }
  const projectLanguageIds = await getProjectLanguageIds(token, projectId);
  const stringIdCache = new Map();
  const snapshotEntries = [];
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

      if (!SNAPSHOT_MODE && process.env.DRY_RUN === "true") {
        console.log(`[DRY RUN] would sync ${fileName} [${key}] -> Crowdin (${languageId}): ${JSON.stringify(newValue)}`);
        pushedCount++;
        continue;
      }

      const stringId = await resolveStringId(token, projectId, key, stringIdCache);
      if (!stringId) {
        console.warn(`WARNING: no Crowdin string found for identifier "${key}" - skipping ${fileName}.`);
        continue;
      }

      if (SNAPSHOT_MODE) {
        let approved = false;
        try {
          const old = await findMatchingTranslation(token, projectId, stringId, languageId, oldMap.get(key));
          approved = old ? await isTranslationApproved(token, projectId, stringId, languageId, old.id) : false;
        } catch (err) {
          console.warn(`WARNING: could not read approval state for ${fileName} [${key}]: ${err.message}`);
        }
        snapshotEntries.push({ fileName, key, approved });
        console.log(`Snapshot ${fileName} [${key}]: ${approved ? "approved" : "pending"}.`);
        continue;
      }

      const knownApproved = snapshot ? Boolean(snapshot.get(`${fileName} ${key}`)) : null;

      try {
        const approved = await pushTranslationMirroringApproval(
          token,
          projectId,
          stringId,
          languageId,
          oldMap.get(key),
          newValue,
          { forceNoApproval, knownApproved },
        );
        console.log(
          `Synced ${fileName} [${key}] -> Crowdin (${languageId}), ${approved ? "approved" : "pending approval"}.`,
        );
        pushedCount++;
      } catch (err) {
        console.warn(
          `WARNING: failed to sync ${fileName} [${key}]: ${err.message}`,
        );
      }
    }
  }

  if (SNAPSHOT_MODE) {
    writeSnapshot(snapshotEntries);
    console.log(`Wrote approval snapshot for ${snapshotEntries.length} translation(s).`);
    return;
  }

  console.log(`Done. Pushed ${pushedCount} synchronized translation(s) to Crowdin.`);
}

main().catch((err) => {
  console.error(err);
  // --snapshot is best-effort: never block the source upload / sync on it.
  if (SNAPSHOT_MODE) {
    try { writeSnapshot([], false); } catch {}
    process.exit(0);
  }
  process.exit(1);
});
