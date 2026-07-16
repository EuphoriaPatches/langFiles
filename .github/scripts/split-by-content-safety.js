// Checks incoming translation updates (_new/) for content safety issues:
// profanity, suspicious URLs (phishing), phone numbers, HTML/script
// injection, and spam/repetition patterns. Clean updates are patched
// in-place; flagged content is saved to _flagged-report.json for review.
// Requires: `PROFANITY_REPO_TOKEN` environment variable.
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..");
const NEW_LANG_DIR = path.join(ROOT, "_new");
const NEW_WEBSITE_DIR = path.join(ROOT, "_new", "website");
const REPORT_PATH = path.join(ROOT, "_flagged-report.json");

const WORDLIST_REPO = "SpacEagle17/Profanity-Filter";
const WORDLIST_PATH = "lists";

const ENTRY_RE = /^([^#\s][^=]*)=(.*)$/;

// ---------------------------------------------------------------------
// Profanity wordlists
// ---------------------------------------------------------------------

function deriveWordlistCode(langId) {
  return langId.split(/[_-]/)[0].toLowerCase();
}

// Scripts that don't reliably delimit words with spaces, so a wordlist
// entry can only be found by scanning for it as a substring - tokenizing
// on whitespace would just produce one giant "token" per sentence.
const SUBSTRING_ONLY_CODES = new Set(["ja", "zh", "th"]);

// Known-safe terms that happen to contain a flagged substring
const SAFE_TERM_EXCEPTIONS = {
  ja: ["カスタム", "カスタマイズ"],
};

function maskSafeTerms(text, wordlistCode) {
  const exceptions = SAFE_TERM_EXCEPTIONS[wordlistCode];
  if (!exceptions) return text;
  let masked = text;
  for (const term of exceptions) {
    masked = masked.split(term).join(" ".repeat(term.length));
  }
  return masked;
}

const TOKEN_RE = /[\p{L}\p{N}]+/gu;

async function fetchWordlist(wordlistCode) {
  const token = process.env.PROFANITY_REPO_TOKEN;
  if (!token) {
    throw new Error(
      "PROFANITY_REPO_TOKEN env var is not set - cannot fetch wordlists.",
    );
  }
  const url = `https://api.github.com/repos/${WORDLIST_REPO}/contents/${WORDLIST_PATH}/${wordlistCode}.json`;
  const res = await fetch(url, {
    headers: {
      Authorization: `token ${token}`,
      Accept: "application/vnd.github.raw",
    },
  });
  if (!res.ok) return [];
  const words = await res.json();
  return Array.isArray(words)
    ? words.filter((w) => typeof w === "string" && w.trim())
    : [];
}

const MIN_SUBSTRING_LATIN_LENGTH = 3;
const PURE_LATIN_RE = /^[a-z]+$/;

function buildIndex(words, wordlistCode) {
  const wordSet = new Set();
  const substringList = [];
  const forceSubstring = SUBSTRING_ONLY_CODES.has(wordlistCode);

  for (const raw of words) {
    const w = raw.toLowerCase().trim();
    if (!w) continue;
    if (forceSubstring || w.includes(" ")) {
      if (PURE_LATIN_RE.test(w) && w.length < MIN_SUBSTRING_LATIN_LENGTH)
        continue;
      substringList.push(w);
    } else {
      wordSet.add(w);
    }
  }

  return { wordSet, substringList };
}

const wordlistIndexCache = new Map();
async function getWordlistIndex(wordlistCode) {
  if (wordlistIndexCache.has(wordlistCode))
    return wordlistIndexCache.get(wordlistCode);
  const words = await fetchWordlist(wordlistCode);
  const index = words.length > 0 ? buildIndex(words, wordlistCode) : null;
  wordlistIndexCache.set(wordlistCode, index);
  return index;
}

const warnedLanguages = new Set();
function warnOnce(langId, message) {
  if (warnedLanguages.has(langId)) return;
  warnedLanguages.add(langId);
  console.warn(
    `WARNING: ${message} - flagging "${langId}" changes for manual review instead of skipping the check.`,
  );
}

// Fails closed: no wordlist coverage means we can't rule out profanity, so
// treat it as flagged rather than silently letting it through unchecked.
async function checkProfanity(text, langId) {
  const wordlistCode = deriveWordlistCode(langId);

  const index = await getWordlistIndex(wordlistCode);
  if (!index) {
    warnOnce(langId, `wordlist fetch failed/empty for "${wordlistCode}"`);
    return { flagged: true, matches: [], noWordlist: true };
  }

  const lower = text.toLowerCase();
  const matches = new Set();

  const tokens = lower.match(TOKEN_RE) || [];
  for (const token of tokens) {
    if (index.wordSet.has(token)) matches.add(token);
  }

  const maskedForSubstring = maskSafeTerms(lower, wordlistCode);
  for (const phrase of index.substringList) {
    if (maskedForSubstring.includes(phrase)) matches.add(phrase);
  }

  return {
    flagged: matches.size > 0,
    matches: [...matches],
    noWordlist: false,
  };
}

// ---------------------------------------------------------------------
// Phishing checks: suspicious URLs, homoglyph domains, phone numbers
// ---------------------------------------------------------------------

// Each entry is either a bare domain (any path/subdomain on it is allowed)
// or a domain+path prefix (only that exact page or its sub-paths are
// allowed)
const WHITELISTED_URL_PREFIXES = [
  "euphoriapatches.com",
  "complementary.dev",
  "modrinth.com/mod/euphoria-patches",
  "modrinth.com/shader/complementary-reimagined",
  "modrinth.com/shader/complementary-unbound",
  "github.com/EuphoriaPatches",
  "crowdin.com/project/EuphoriaPatchesShader",
  "crowdin.com/project/EuphoriaPatchesWebsite",
  "patreon.com/c/SpacEagle17",
  "www.patreon.com/cw/SpacEagle17",
  "ko-fi.com/spaceagle17",
];

// The domain-label character class includes the homoglyph ranges (not just
// [a-z0-9-]) so a spoofed domain like "gооgle.com" (Cyrillic о's) is
// captured as one complete token instead of the regex skipping the
// non-ASCII characters and matching a truncated, misleading fragment.
const URL_RE =
  /(https?:\/\/[^\s"'<>]+|www\.[^\s"'<>]+|\b[a-z0-9\-Ѐ-ӿͰ-Ͽ]+(?:\.[a-z0-9\-Ѐ-ӿͰ-Ͽ]+)*\.(?:com|dev|gg|io|org|net|co|app|me|xyz|link)\b[^\s"'<>]*)/giu;

// Strips protocol/www and a trailing slash, giving a "domain/path" string
// suitable for both domain-only and domain+path prefix comparisons.
function normalizeUrl(urlLike) {
  return urlLike
    .replace(/^https?:\/\//i, "")
    .replace(/^www\./i, "")
    .replace(/\/$/, "")
    .toLowerCase();
}

function matchesWhitelistEntry(normalizedUrl, entry) {
  const prefix = entry.toLowerCase().replace(/\/$/, "");

  if (!prefix.includes("/")) {
    // Bare domain: allow the domain itself, any path on it, or any subdomain.
    return (
      normalizedUrl === prefix ||
      normalizedUrl.startsWith(`${prefix}/`) ||
      normalizedUrl.endsWith(`.${prefix}`) ||
      normalizedUrl.includes(`.${prefix}/`)
    );
  }

  // Domain+path: only that exact page or a sub-path of it - startsWith alone
  // would let "euphoria-patches-scam" slip through a prefix meant to match
  // only "euphoria-patches", so a "/" boundary is required after the prefix.
  return normalizedUrl === prefix || normalizedUrl.startsWith(`${prefix}/`);
}

function isUrlWhitelisted(normalizedUrl) {
  return WHITELISTED_URL_PREFIXES.some((entry) =>
    matchesWhitelistEntry(normalizedUrl, entry),
  );
}

// Cyrillic and Greek ranges commonly used to spoof Latin domain names
// (e.g. a Cyrillic "о" standing in for a Latin "o" in "gооgle.com").
const HOMOGLYPH_RE = /[Ѐ-ӿͰ-Ͽ]/;
const LATIN_RE = /[a-z]/i;

function hasHomoglyphMix(token) {
  return LATIN_RE.test(token) && HOMOGLYPH_RE.test(token);
}

function findSuspiciousUrls(text, englishSourceValue) {
  const matches = text.match(URL_RE) || [];
  const sourceLower = (englishSourceValue || "").toLowerCase();
  const found = [];

  for (const match of matches) {
    if (hasHomoglyphMix(match)) {
      found.push({ reason: "homoglyph-url", detail: match });
      continue;
    }

    const normalized = normalizeUrl(match);
    if (!normalized || !normalized.includes(".")) continue;

    const alreadyInSource = sourceLower.includes(normalized);
    if (!alreadyInSource && !isUrlWhitelisted(normalized)) {
      found.push({ reason: "suspicious-url", detail: match });
    }
  }

  return found;
}

// Permissive on purpose - false positives just mean an extra manual review,
// while a missed real phone number defeats the point of the check.
const PHONE_RE = /(?:\+\d{1,3}[\s.-]?)?(?:\(?\d{2,4}\)?[\s.-]){2,5}\d{2,4}/g;

function findPhoneNumbers(text) {
  const matches = text.match(PHONE_RE) || [];
  return matches
    .map((m) => m.trim())
    .filter((m) => m.replace(/\D/g, "").length >= 7);
}

// ---------------------------------------------------------------------
// HTML/script injection - website JSON gets rendered on a real webpage
// ---------------------------------------------------------------------

const HTML_INJECTION_RE =
  /<\s*(script|iframe|object|embed|link|style|img)\b|javascript:|on(error|click|load|mouseover|focus|mouseenter)\s*=/i;

function findHtmlInjection(text) {
  const match = text.match(HTML_INJECTION_RE);
  return match ? match[0] : null;
}

// ---------------------------------------------------------------------
// Spam / repetition
// ---------------------------------------------------------------------

function hasSpamRepetition(text) {
  if (/(.)\1{7,}/u.test(text)) return true;
  const words = text.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) || [];
  const counts = new Map();
  for (const w of words) {
    const count = (counts.get(w) || 0) + 1;
    counts.set(w, count);
    if (count >= 5) return true;
  }
  return false;
}

// ---------------------------------------------------------------------
// Combined check
// ---------------------------------------------------------------------

// Cheap synchronous checks run first so an obvious phishing/injection/spam
// hit never needs a wordlist fetch. Profanity (the only async check, since
// it fetches remote data) only runs if nothing else already flagged it.
async function checkContentIssues(text, langId, englishSourceValue) {
  const issues = [];

  for (const url of findSuspiciousUrls(text, englishSourceValue)) {
    issues.push({ reason: url.reason, detail: url.detail });
  }
  for (const phone of findPhoneNumbers(text)) {
    issues.push({ reason: "phone-number", detail: phone });
  }
  const html = findHtmlInjection(text);
  if (html) issues.push({ reason: "html-injection", detail: html });
  if (hasSpamRepetition(text)) {
    issues.push({
      reason: "spam-repetition",
      detail: "repeated character/word pattern",
    });
  }

  if (issues.length > 0) {
    return {
      flagged: true,
      matches: issues.map((i) => i.detail),
      reasons: [...new Set(issues.map((i) => i.reason))],
    };
  }

  const profanity = await checkProfanity(text, langId);
  return {
    flagged: profanity.flagged,
    matches: profanity.matches,
    reasons: profanity.flagged
      ? [profanity.noWordlist ? "no-wordlist-coverage" : "profanity-match"]
      : [],
  };
}

// ---------------------------------------------------------------------
// File parsing/patching
// ---------------------------------------------------------------------

function splitLines(raw) {
  return raw.split(/\r\n|\n/);
}

function detectEol(raw) {
  return raw.includes("\r\n") ? "\r\n" : "\n";
}

function loadLangMap(raw) {
  const map = new Map();
  splitLines(raw).forEach((line) => {
    const m = line.match(ENTRY_RE);
    if (m) map.set(m[1], m[2]);
  });
  return map;
}

function parseLangEntries(lines) {
  const map = new Map();
  lines.forEach((line, index) => {
    const m = line.match(ENTRY_RE);
    if (m) map.set(m[1], { value: m[2], index });
  });
  return map;
}

// Patches only the given keys onto the existing .lang file structure.
// Existing keys get their line replaced in place; brand-new keys get
// inserted next to the nearest neighboring key that exists in this file,
// walking outward through the source's key order (same technique as
// restore-empty-lang-keys.js).
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
        for (
          let i = srcIdx + 1;
          i < sourceKeyOrder.length && insertAt === null;
          i++
        ) {
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

// ---------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------

async function main() {
  const sourceRaw = fs.readFileSync(path.join(ROOT, "en_US.lang"), "utf8");
  const sourceKeyOrder = [];
  splitLines(sourceRaw).forEach((line) => {
    const m = line.match(ENTRY_RE);
    if (m) sourceKeyOrder.push(m[1]);
  });
  const sourceLangMap = loadLangMap(sourceRaw);

  const websiteEnPath = path.join(ROOT, "website", "en.json");
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
      const oldPath = path.join(ROOT, fileName);
      const newPath = path.join(NEW_LANG_DIR, fileName);
      if (!fs.existsSync(oldPath)) continue;

      const oldRaw = fs.readFileSync(oldPath, "utf8");
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

      if (cleanUpdates.size > 0) {
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
      const oldPath = path.join(ROOT, "website", fileName);
      const newPath = path.join(NEW_WEBSITE_DIR, fileName);
      if (!fs.existsSync(oldPath)) continue;

      const oldRaw = fs.readFileSync(oldPath, "utf8");
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
