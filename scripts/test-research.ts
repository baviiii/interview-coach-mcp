/**
 * Pure-unit checks for the career-agnostic research layer (no network, no LLM).
 * Run: `npm test`. Asserts the behaviors that matter most:
 *   - non-tech fields no longer get the tech catalog dumped on them
 *   - researched credentials merge in WITH their source, catalog keeps its facts
 *   - research bucketing drops sourceless items, dedupes, and caps
 *   - the REAL-WORLD SIGNALS prompt block renders sources / stays empty when bare
 */
import assert from "node:assert/strict";

import {
  formatCredentialCandidates,
  mergeCredentialCandidates,
  nextCertSuggestions,
} from "../src/domain/certifications.js";
import { realWorldBlock } from "../src/domain/prompts.js";
import { emptyResearch, type ResearchSnippet } from "../src/adapters/research/port.js";
import { bucketSnippets } from "../src/adapters/research/util.js";

let passed = 0;
function check(name: string, fn: () => void) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

console.log("\nresearch layer unit checks:");

// 1) Non-tech field + researched credentials ⇒ NO tech catalog fallback (the
//    "AWS for a nurse" bug). With creds present we pass fallbackToAll:false.
check("non-tech field gets no tech-catalog fallback", () => {
  const suggestions = nextCertSuggestions({
    field: "Registered Nurse",
    ownedCatalogIds: [],
    fallbackToAll: false,
  });
  assert.equal(suggestions.length, 0, "nurse should get zero catalog certs (no AWS)");
});

// 2) Legacy behavior preserved: with fallback on, an unknown field still yields
//    catalog certs (so research-off mode doesn't regress).
check("fallback on still yields catalog certs", () => {
  const suggestions = nextCertSuggestions({ field: "Registered Nurse", ownedCatalogIds: [] });
  assert.ok(suggestions.length > 0, "fallback should yield something when research is absent");
});

// 3) Tech field still matches the catalog directly.
check("tech field matches catalog", () => {
  const suggestions = nextCertSuggestions({ field: "DevOps & SRE", ownedCatalogIds: [], fallbackToAll: false });
  assert.ok(suggestions.length > 0, "DevOps should match catalog certs");
});

// 4) Merge: catalog entries keep source "catalog"; researched ones carry a URL.
check("mergeCredentialCandidates marks sources correctly", () => {
  const catalog = nextCertSuggestions({ field: "DevOps & SRE", ownedCatalogIds: [], max: 2 });
  const researched: ResearchSnippet[] = [
    {
      kind: "credential",
      text: "National Council Licensure Examination: the NCLEX is required to practice as an RN.",
      sourceUrl: "https://en.wikipedia.org/wiki/NCLEX",
      sourceLabel: "Wikipedia",
    },
  ];
  const merged = mergeCredentialCandidates(catalog, researched, 8);
  const cat = merged.find((c) => c.source === "catalog");
  const res = merged.find((c) => c.source.startsWith("http"));
  assert.ok(cat, "should keep a catalog entry");
  assert.ok(res, "should include a researched credential");
  assert.equal(res!.name, "National Council Licensure Examination", "name is taken before the colon");
  assert.equal(res!.id, null, "researched creds have no catalog id");
});

// 5) Merge skips ramble that doesn't look like a credential NAME.
check("merge skips non-name credential ramble", () => {
  const researched: ResearchSnippet[] = [
    {
      kind: "credential",
      text: "Honestly I regret spending money on that bootcamp, it didn't help me at all in interviews?",
      sourceUrl: "https://www.reddit.com/r/x/comments/1/",
      sourceLabel: "r/x",
    },
  ];
  const merged = mergeCredentialCandidates([], researched, 8);
  assert.equal(merged.length, 0, "rambly forum titles should not become named credentials");
});

// 6) formatCredentialCandidates is honest when there is nothing.
check("empty candidates render an honest line", () => {
  const line = formatCredentialCandidates([]);
  assert.match(line, /do not invent/i);
});

// 7) bucketSnippets: drops sourceless, dedupes by URL, caps per kind.
check("bucketSnippets hygiene", () => {
  const snippets: ResearchSnippet[] = [
    { kind: "question", text: "Q1", sourceUrl: "https://a", sourceLabel: "r/x" },
    { kind: "question", text: "dupe", sourceUrl: "https://a", sourceLabel: "r/x" }, // dup URL
    { kind: "question", text: "no source", sourceUrl: "", sourceLabel: "r/x" }, // dropped
    { kind: "question", text: "Q2", sourceUrl: "https://b", sourceLabel: "r/x" },
    { kind: "question", text: "Q3", sourceUrl: "https://c", sourceLabel: "r/x" },
  ];
  const r = bucketSnippets("Nursing", undefined, snippets, 2, false);
  assert.equal(r.questions.length, 2, "cap respected (2)");
  assert.equal(r.questions[0]!.text, "Q1");
  assert.equal(r.questions[1]!.text, "Q2", "dup URL + sourceless skipped");
});

// 8) realWorldBlock: empty research ⇒ empty string; populated ⇒ sourced + guardrail.
check("realWorldBlock renders and guards", () => {
  assert.equal(realWorldBlock(emptyResearch("Nursing")), "", "empty research ⇒ no block");
  const r = emptyResearch("Nursing");
  r.experiences.push({
    kind: "experience",
    text: "Froze on the STAR follow-ups.",
    sourceUrl: "https://www.reddit.com/r/nursing/comments/1/",
    sourceLabel: "r/nursing",
    stat: "1.2k upvotes",
  });
  const block = realWorldBlock(r);
  assert.match(block, /REAL-WORLD SIGNALS/);
  assert.match(block, /reddit\.com\/r\/nursing/);
  assert.match(block, /Never invent/i);
});

console.log(`\nOK: ${passed} checks passed.\n`);
