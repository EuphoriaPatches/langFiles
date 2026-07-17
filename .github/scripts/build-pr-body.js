// Builds the flagged-items PR body from _flagged-report.json. Shared by the
// initial PR creation (crowdin.yml) and the /safe-term comment automation
// (pr-safe-term-command.yml), which both need to render the same format -
// the latter after removing items that got resolved via a new exception.
// Reads _flagged-report.json from the current directory, writes pr-body.md.
"use strict";

const fs = require("fs");

const REASON_LABELS = {
  "no-wordlist-coverage": "no profanity wordlist for this language yet - needs one added",
  "profanity-match": "profanity match",
  "suspicious-url": "URL not found in the English source or whitelist",
  "homoglyph-url": "URL contains mixed-script (lookalike) characters",
  "phone-number": "phone number detected",
  "html-injection": "HTML/script injection pattern",
  "spam-repetition": "repeated character/word spam pattern",
};

function main() {
  const items = JSON.parse(fs.readFileSync("_flagged-report.json", "utf8"));
  const slugs = {
    lang: process.env.CROWDIN_PROJECT_SLUG_LANG,
    website: process.env.CROWDIN_PROJECT_SLUG_WEBSITE,
  };

  const lines = [];
  lines.push("New translations from Crowdin were flagged by the content safety check and need manual review before merging.");
  lines.push("");
  lines.push("To mark a flagged term as a known-safe false positive (e.g. a loanword that happens to contain a flagged substring), comment `/safe-term <term>` on this PR - an owner/member/collaborator only.");
  lines.push("");
  lines.push("### Flagged items");

  if (items.length === 0) {
    lines.push("_No flagged items remain._");
  } else {
    for (const item of items) {
      const isWebsite = item.file.startsWith("website/");
      const slug = isWebsite ? slugs.website : slugs.lang;
      const link = `https://crowdin.com/project/${slug}`;
      const reasonText = item.reasons.map((r) => REASON_LABELS[r] || r).join("; ");
      lines.push(`- **${item.file}** \`${item.key}\` (${item.language}) - ${reasonText}`);
      lines.push(`  - Matched: ${item.matchedWords.join(", ")}`);
      lines.push(`  - Old: ${JSON.stringify(item.oldValue)}`);
      lines.push(`  - New: ${JSON.stringify(item.newValue)}`);
      lines.push(`  - [Review in Crowdin](${link}) - search for the key above`);
    }
  }

  lines.push("");
  lines.push("### If rejected");
  lines.push("Delete or fix the translation directly in Crowdin using the links above, so it isn't proposed again unchanged.");

  fs.writeFileSync("pr-body.md", lines.join("\n") + "\n", "utf8");
  console.log("--- PR body ---");
  console.log(fs.readFileSync("pr-body.md", "utf8"));
}

main();
