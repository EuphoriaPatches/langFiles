// Shared detection/parsing logic for the content-safety pipeline. Used by
// split-by-content-safety.js (the main diff-and-split check) and
// resolve-safe-term.js (the /safe-term PR comment automation) so both stay
// in sync instead of drifting apart as separately-maintained copies.
"use strict";

const fs = require("fs");
const path = require("path");

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const SAFE_TERM_EXCEPTIONS_PATH = path.join(
  __dirname,
  "..",
  "..",
  "data",
  "safe-term-exceptions.json",
);

const WORDLIST_REPO = "SpacEagle17/Profanity-Filter";
const WORDLIST_PATH = "lists";

const ENTRY_RE = /^([^#\s][^=]*)=(.*)$/;

// ---------------------------------------------------------------------
// Profanity wordlists
// ---------------------------------------------------------------------

// Overrides for language identifiers whose wordlist code isn't just the
// part before the underscore (see resolveWordlistCode below). Empty for
// now - every current locale here reduces cleanly.
const PROFANITY_LANG_OVERRIDES = {};

function resolveWordlistCode(langId) {
  return (
    PROFANITY_LANG_OVERRIDES[langId] ?? langId.split(/[_-]/)[0].toLowerCase()
  );
}

// Scripts that don't reliably delimit words with spaces, so a wordlist
// entry can only be found by scanning for it as a substring - tokenizing
// on whitespace would just produce one giant "token" per sentence.
const SUBSTRING_ONLY_CODES = new Set(["ja", "zh", "th"]);

function loadSafeTermExceptions() {
  return fs.existsSync(SAFE_TERM_EXCEPTIONS_PATH)
    ? JSON.parse(fs.readFileSync(SAFE_TERM_EXCEPTIONS_PATH, "utf8"))
    : {};
}

function saveSafeTermExceptions(exceptions) {
  fs.writeFileSync(
    SAFE_TERM_EXCEPTIONS_PATH,
    JSON.stringify(exceptions, null, 2) + "\n",
    "utf8",
  );
}

// Known-safe terms that happen to contain a flagged substring (e.g. the
// common loanword "カスタム"/"custom" starts with "カス", also a standalone
// wordlist entry). Lives in its own JSON file (rather than inline here) so
// the PR comment automation (.github/workflows/pr-safe-term-command.yml)
// can safely add new entries without editing JS source.
function maskSafeTerms(text, wordlistCode, exceptions) {
  const terms = exceptions[wordlistCode];
  if (!terms) return text;
  let masked = text;
  for (const term of terms) {
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
async function checkProfanity(text, langId, exceptions) {
  const wordlistCode = resolveWordlistCode(langId);

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

  const maskedForSubstring = maskSafeTerms(lower, wordlistCode, exceptions);
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
  "patreon.com/cw/SpacEagle17",
  "patreon.com/spaceagle17",
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
async function checkContentIssues(text, langId, englishSourceValue, exceptions) {
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

  const profanity = await checkProfanity(text, langId, exceptions);
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
  // splitLines("") returns [""] (one empty element), which would otherwise
  // leave a stray leading blank line when building a brand new file from
  // scratch (oldRaw === "").
  const lines = oldRaw === "" ? [] : splitLines(oldRaw);
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

function loadSourceKeyOrder(sourceRaw) {
  const order = [];
  splitLines(sourceRaw).forEach((line) => {
    const m = line.match(ENTRY_RE);
    if (m) order.push(m[1]);
  });
  return order;
}

module.exports = {
  REPO_ROOT,
  resolveWordlistCode,
  loadSafeTermExceptions,
  saveSafeTermExceptions,
  checkContentIssues,
  splitLines,
  detectEol,
  loadLangMap,
  parseLangEntries,
  patchLangFile,
  patchJsonFile,
  loadSourceKeyOrder,
  ENTRY_RE,
};
