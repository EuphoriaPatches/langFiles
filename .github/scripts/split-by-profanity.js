// Checks incoming translation updates (_new/) for profanity using remote wordlists.
// Clean updates are patched in-place; flagged content is saved to _flagged-report.json.
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

// Maps this repo's language identifiers (the .lang/.json filename, minus
// extension) to the wordlist file that covers that language.
const PROFANITY_LANG_MAP = {
  // shader lang project (Minecraft-style codes)
  ja_JP: "ja",
  ko_KR: "ko",
  pl_PL: "pl",
  pt_BR: "pt",
  ru_RU: "ru",
  uk_UA: "uk",
  zh_CN: "zh",
  zh_HK: "zh",
  // website project (Crowdin-style codes)
  de: "de",
  "es-ES": "es",
  es: "es",
  fr: "fr",
  he: "he",
  ja: "ja",
  nl: "nl",
  pl: "pl",
  "pt-BR": "pt",
  ru: "ru",
  sv: "sv",
  th: "th",
  tr: "tr",
  uk: "uk",
  "zh-CN": "zh",
  "zh-HK": "zh",
};

// Scripts that don't reliably delimit words with spaces, so a wordlist
// entry can only be found by scanning for it as a substring - tokenizing
// on whitespace would just produce one giant "token" per sentence.
const SUBSTRING_ONLY_CODES = new Set(["ja", "zh", "th"]);

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

// Builds a fast lookup index for one wordlist:
// - wordSet: single-word entries, checked via O(1) Set membership against
//   tokenized input (for space-delimited languages).
// - substringList: multi-word phrases, plus (for CJK/Thai) every entry,
//   checked via .includes() since tokenization doesn't apply there.
function buildIndex(words, wordlistCode) {
  const wordSet = new Set();
  const substringList = [];
  const forceSubstring = SUBSTRING_ONLY_CODES.has(wordlistCode);

  for (const raw of words) {
    const w = raw.toLowerCase().trim();
    if (!w) continue;
    if (forceSubstring || w.includes(" ")) {
      if (PURE_LATIN_RE.test(w) && w.length < MIN_SUBSTRING_LATIN_LENGTH) continue;
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
  const wordlistCode = PROFANITY_LANG_MAP[langId];
  if (!wordlistCode) {
    warnOnce(langId, `no wordlist mapping for language "${langId}"`);
    return { flagged: true, matches: [], noWordlist: true };
  }

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

  for (const phrase of index.substringList) {
    if (lower.includes(phrase)) matches.add(phrase);
  }

  return {
    flagged: matches.size > 0,
    matches: [...matches],
    noWordlist: false,
  };
}

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

async function main() {
  const sourceRaw = fs.readFileSync(path.join(ROOT, "en_US.lang"), "utf8");
  const sourceKeyOrder = [];
  splitLines(sourceRaw).forEach((line) => {
    const m = line.match(ENTRY_RE);
    if (m) sourceKeyOrder.push(m[1]);
  });

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
        const { flagged, matches, noWordlist } = await checkProfanity(
          newValue,
          langId,
        );
        if (flagged) {
          flaggedReport.push({
            file: fileName,
            key,
            language: langId,
            oldValue: oldMap.get(key) ?? "",
            newValue,
            matchedWords: matches,
            reason: noWordlist ? "no-wordlist-coverage" : "profanity-match",
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
        const { flagged, matches, noWordlist } = await checkProfanity(
          newValue,
          langId,
        );
        if (flagged) {
          flaggedReport.push({
            file: relFile,
            key,
            language: langId,
            oldValue: oldObj[key] ?? "",
            newValue,
            matchedWords: matches,
            reason: noWordlist ? "no-wordlist-coverage" : "profanity-match",
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

  fs.rmSync(NEW_LANG_DIR, { recursive: true, force: true });

  fs.writeFileSync(REPORT_PATH, JSON.stringify(flaggedReport, null, 2), "utf8");

  if (flaggedReport.length === 0) {
    console.log("No flagged content this run.");
  } else {
    console.log(`${flaggedReport.length} flagged item(s):`);
    for (const item of flaggedReport) {
      console.log(
        `  ${item.file} [${item.key}] (${item.language}) matched: ${item.matchedWords.join(", ")}`,
      );
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
