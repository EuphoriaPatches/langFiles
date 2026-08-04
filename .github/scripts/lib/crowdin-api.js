// Shared Crowdin REST API v2 helpers. Used by sync-manual-lang-edits.js
// (pushing hand-synced translations up to Crowdin) and process-pr-commands.js
// (the /reject PR command deleting a rejected translation from Crowdin), so
// both stay in sync instead of drifting apart as separately-maintained
// copies of the same request/matching logic.
"use strict";

const CROWDIN_API = "https://api.crowdin.com/api/v2";

async function crowdinRequest(token, method, urlPath, body) {
  const res = await fetch(`${CROWDIN_API}${urlPath}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  // DELETE responses have no body.
  const json = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error(
      `Crowdin API ${method} ${urlPath} failed (${res.status}): ${JSON.stringify(json)}`,
    );
    err.body = json;
    throw err;
  }
  return json;
}

// Crowdin rejects POST /translations when a translation with identical text
// already exists for that string+language (e.g. added by its own TM
// pre-translation step, which runs upstream of sync-manual-lang-edits.js in
// the sync-lang job) - it wants you to approve the existing one instead of
// creating a duplicate.
function isDuplicateTranslationError(err) {
  const errors = err.body && err.body.errors;
  if (!Array.isArray(errors)) return false;
  return errors.some((e) =>
    ((e.error && e.error.errors) || []).some(
      (inner) => inner.code === "validationError" && /duplicate translation/i.test(inner.message || ""),
    ),
  );
}

async function listTranslations(token, projectId, stringId, languageId) {
  const result = await crowdinRequest(
    token,
    "GET",
    `/projects/${projectId}/translations?stringId=${stringId}&languageId=${languageId}`,
  );
  return (result.data || []).map((item) => item.data);
}

async function findMatchingTranslation(token, projectId, stringId, languageId, text) {
  const translations = await listTranslations(token, projectId, stringId, languageId);
  return translations.find((t) => t.text === text) || null;
}

async function deleteTranslation(token, projectId, translationId) {
  await crowdinRequest(token, "DELETE", `/projects/${projectId}/translations/${translationId}`);
}

// Submits `text` as a translation for stringId+languageId and (by default)
// approves it - used for translations we're pushing on a translator's
// behalf (they didn't type this exact text into Crowdin themselves, but
// it's a direct derivative of what they did submit, e.g. a hand-synced
// value or an automated punctuation fix) rather than actual
// community-submitted work awaiting review. Falls back to approving the
// existing translation instead of creating a duplicate, since Crowdin
// rejects a second identical one (see isDuplicateTranslationError).
//
// Pass `approve: false` (wired to the workflow's disable_crowdin_auto_approval
// input) to submit without approving, e.g. while validating that these
// automated pushes are producing the right text before trusting them
// unattended.
async function pushAndApproveTranslation(token, projectId, stringId, languageId, text, approve = true) {
  let translationId;
  try {
    const translation = await crowdinRequest(
      token,
      "POST",
      `/projects/${projectId}/translations`,
      { stringId, languageId, text },
    );
    translationId = translation.data.id;
  } catch (err) {
    if (!isDuplicateTranslationError(err)) throw err;
    const existing = await findMatchingTranslation(token, projectId, stringId, languageId, text);
    if (!existing) throw err;
    translationId = existing.id;
  }
  if (approve) {
    await crowdinRequest(token, "POST", `/projects/${projectId}/approvals`, { translationId });
  }
}

// Get the list of language IDs that exist in the Crowdin project, so we can
// map a local file name to the correct Crowdin language ID (e.g. "fr" vs
// "fr-FR" vs "fr-CA"). Needed for both projects - file-naming placeholders
// like %locale%/%locale_with_underscore% (optionally further overridden per
// project via Crowdin's own Language Mapping UI) are export-naming
// conveniences, not guaranteed to equal the language's real API id.
async function getProjectLanguageIds(token, projectId) {
  const result = await crowdinRequest(token, "GET", `/projects/${projectId}`);
  return (result.data.targetLanguages || []).map((l) => l.id);
}

function resolveCrowdinLanguageId(langId, projectLanguageIds) {
  const [base, region] = langId.split(/[_-]/);
  const baseLower = base.toLowerCase();

  if (projectLanguageIds.includes(baseLower)) return baseLower;

  const dialectMatches = projectLanguageIds.filter((id) =>
    id.toLowerCase().startsWith(`${baseLower}-`),
  );
  if (dialectMatches.length === 1) return dialectMatches[0];
  if (dialectMatches.length > 1 && region) {
    const exact = dialectMatches.find(
      (id) => id.toLowerCase() === `${baseLower}-${region.toLowerCase()}`,
    );
    if (exact) return exact;
  }
  return null;
}

async function resolveStringId(token, projectId, key, cache) {
  const cacheKey = `${projectId}:${key}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey);
  const result = await crowdinRequest(
    token,
    "GET",
    `/projects/${projectId}/strings?filter=${encodeURIComponent(key)}&scope=identifier&limit=50`,
  );
  const match = (result.data || []).find((item) => item.data.identifier === key);
  const id = match ? match.data.id : null;
  cache.set(cacheKey, id);
  return id;
}

module.exports = {
  crowdinRequest,
  isDuplicateTranslationError,
  listTranslations,
  findMatchingTranslation,
  deleteTranslation,
  pushAndApproveTranslation,
  getProjectLanguageIds,
  resolveCrowdinLanguageId,
  resolveStringId,
};
