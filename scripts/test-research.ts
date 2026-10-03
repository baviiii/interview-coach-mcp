/**
 * Pure-unit checks for the career-agnostic layer (no network, no LLM).
 * Run: `npm test`. Asserts the behaviors that matter most:
 *   - no field gets another field's credentials; the catalog never suggests on its own
 *   - researched credentials keep their source, the catalog only enriches
 *   - field profiles are validated, and a neutral profile assumes no occupation
 *   - the interview loop takes its formats from the field, not from software defaults
 *   - research bucketing drops sourceless items, dedupes, and caps
 *   - the REAL-WORLD SIGNALS prompt block renders sources / stays empty when bare
 */
import assert from "node:assert/strict";

import {
  buildCredentialCandidates,
  formatCredentialCandidates,
  matchCertification,
} from "../src/domain/certifications.js";
import {
  describeInterviewStyle,
  neutralProfile,
  parseFieldProfile,
  seniorityBand,
  type FieldProfile,
} from "../src/domain/field-profile.js";
import { resolveGoal, withTargetTitleFirst } from "../src/domain/goal.js";
import { interviewBlueprint } from "../src/domain/interview-loop.js";
import { realWorldBlock } from "../src/domain/prompts.js";
import { deriveSkillTargets } from "../src/domain/targets.js";
import { withMarket, type InferRequest, type ModelProvider } from "../src/adapters/horus/index.js";
import { emptyResearch, type ResearchSnippet } from "../src/adapters/research/port.js";
import { bucketSnippets } from "../src/adapters/research/util.js";
import { titleFitsField } from "../src/adapters/research/wikipedia-client.js";
import type { LearnerContext } from "../src/types.js";

let passed = 0;
function check(name: string, fn: () => void) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

const emptyCtx: LearnerContext = {
  userId: "test",
  skills: [],
  weakSkills: [],
  strongSkills: [],
  recentOverallScores: [],
  certifications: [],
};

const nurse: FieldProfile = {
  field: "Registered Nurse",
  canonicalTitle: "Registered Nurse",
  levels: { entry: "Graduate nurse" },
  technicalWeight: 0.5,
  keySkills: ["Patient assessment", "Medication safety", "Clinical judgment", "Communication"],
  domainFormats: ["practical", "case_study", "technical"],
  credentials: [
    { name: "NCLEX-RN", required: true, note: "Licensure exam." },
    { name: "Basic Life Support (BLS)", required: true, note: "" },
    { name: "RN", required: true, note: "State registration." },
  ],
  source: "model",
};

console.log("\ncareer-agnostic unit checks:");

// 1) The catalog is enrichment only — with nothing researched or expected,
//    nobody gets its (tech-heavy) contents dumped on them.
check("catalog never suggests on its own", () => {
  assert.deepEqual(buildCredentialCandidates({ researched: [], expected: [], held: [] }), []);
});

// 2) A nurse gets nursing credentials, and none of them is mistaken for a tech cert.
check("nurse gets nurse credentials, never tech", () => {
  const c = buildCredentialCandidates({ researched: [], expected: nurse.credentials, held: [] });
  assert.deepEqual(
    c.map((x) => x.name),
    ["NCLEX-RN", "Basic Life Support (BLS)", "RN"],
  );
  assert.ok(c.every((x) => x.id === null && x.source === "model knowledge"), "no catalog match for nursing creds");
  assert.match(c[0]!.marketSignal, /Required to practise/);
});

// 3) When the field's credential IS in the catalog, its facts fill in.
check("catalog enriches a credential it recognises", () => {
  const [c] = buildCredentialCandidates({
    researched: [],
    expected: [{ name: "AWS Certified Solutions Architect - Associate", required: false, note: "" }],
    held: [],
    seniority: "Mid-Level",
  });
  assert.equal(c!.id, "aws-saa");
  assert.equal(c!.examCostUsd, 150);
  assert.equal(c!.levelFit, "ideal");
  assert.equal(c!.source, "model knowledge");
});

// 4) Held credentials drop out, and prerequisites they satisfy aren't flagged.
check("held credentials are skipped", () => {
  const c = buildCredentialCandidates({
    researched: [],
    expected: [
      { name: "AWS Certified Solutions Architect - Associate", required: false, note: "" },
      { name: "AWS Certified Solutions Architect - Professional", required: false, note: "" },
    ],
    held: [{ name: "AWS Solutions Architect Associate", catalogId: "aws-saa" }],
  });
  assert.deepEqual(c.map((x) => x.id), ["aws-sap"]);
  assert.equal(c[0]!.prereqNote, undefined);
});

// 5) Researched credentials come first and keep their URL.
check("researched credentials keep their source", () => {
  const researched: ResearchSnippet[] = [
    {
      kind: "credential",
      text: "National Council Licensure Examination: the NCLEX is required to practice as an RN.",
      sourceUrl: "https://en.wikipedia.org/wiki/NCLEX",
      sourceLabel: "Wikipedia",
    },
  ];
  const c = buildCredentialCandidates({ researched, expected: nurse.credentials, held: [] });
  assert.equal(c[0]!.name, "National Council Licensure Examination", "name is taken before the colon");
  assert.equal(c[0]!.source, "https://en.wikipedia.org/wiki/NCLEX");
  assert.equal(c[0]!.id, null);
});

// 6) Ramble that doesn't look like a credential NAME is not promoted.
check("merge skips non-name credential ramble", () => {
  const researched: ResearchSnippet[] = [
    {
      kind: "credential",
      text: "Honestly I regret spending money on that bootcamp, it didn't help me at all in interviews?",
      sourceUrl: "https://www.reddit.com/r/x/comments/1/",
      sourceLabel: "r/x",
    },
  ];
  assert.equal(buildCredentialCandidates({ researched, expected: [], held: [] }).length, 0);
});

// 7) Catalog matching is whole-word: "RN" used to match inside "kubernetes".
check("matchCertification matches whole words only", () => {
  assert.equal(matchCertification("RN"), null);
  assert.equal(matchCertification("Associate"), null);
  assert.equal(matchCertification("CKA")?.id, "cka");
  assert.equal(matchCertification("AWS Solutions Architect Associate")?.id, "aws-saa");
});

// 8) Profiles are validated field by field; nothing usable ⇒ null (caller goes neutral).
check("parseFieldProfile validates and clamps", () => {
  const p = parseFieldProfile("Chef", {
    keySkills: ["Knife skills", "Food safety", "", 42],
    technicalWeight: 0.95,
    domainFormats: ["Practical", "whiteboard", "case study"],
    credentials: [{ name: "Food Safety Supervisor", required: true, note: "Required in NSW." }, { note: "no name" }],
  });
  assert.deepEqual(p!.keySkills, ["Knife skills", "Food safety"]);
  assert.equal(p!.technicalWeight, 0.8);
  assert.deepEqual(p!.domainFormats, ["practical", "case_study"]);
  assert.equal(p!.credentials.length, 1);
  assert.equal(parseFieldProfile("Chef", "not json"), null);
  assert.equal(parseFieldProfile("Chef", { technicalWeight: 0.5 }), null);
});

// 9) The loop's formats come from the field — software formats only when the
//    field asks for them — and the behavioural floor holds either way.
check("interview loop formats follow the field", () => {
  const types = (bp: ReturnType<typeof interviewBlueprint>) => new Set(bp.slots.map((s) => s.type));

  const neutral = interviewBlueprint({ field: "Welder", questionCount: 6 });
  assert.ok(!types(neutral).has("coding") && !types(neutral).has("system_design"), "neutral assumes no software");
  assert.equal(neutral.fieldMatched, false);

  const rn = interviewBlueprint({ field: "Registered Nurse", questionCount: 6, profile: nurse });
  assert.ok(types(rn).has("practical"));
  assert.ok(!types(rn).has("coding"));
  assert.deepEqual(rn.keySkills, nurse.keySkills);
  assert.ok(rn.behavioralCount >= 2);

  const swe = interviewBlueprint({
    field: "Backend Engineer",
    questionCount: 6,
    profile: { ...neutralProfile("Backend Engineer"), keySkills: ["APIs"], domainFormats: ["coding", "system_design"], source: "model" },
  });
  assert.ok(types(swe).has("coding"));
  assert.ok(swe.behavioralCount >= 2);
});

// 10) Cold-start targets come from the field's profile, and with nothing known
//     fall back to skills true of every job — never to a tech list.
check("cold-start targets come from the field", () => {
  const fromProfile = deriveSkillTargets({ ctx: emptyCtx, field: "Registered Nurse", profile: nurse });
  assert.equal(fromProfile.source, "field");
  assert.equal(fromProfile.targets[0]!.skill, "Patient assessment");

  const unknown = deriveSkillTargets({ ctx: emptyCtx, field: "Welder", profile: neutralProfile("Welder") });
  assert.deepEqual(
    unknown.targets.map((t) => t.skill),
    ["Communication", "Problem Solving", "Teamwork", "Adaptability"],
  );
});

// 11) formatCredentialCandidates is honest when there is nothing.
check("empty candidates render an honest line", () => {
  const line = formatCredentialCandidates([]);
  assert.match(line, /do not invent/i);
});

// 12) bucketSnippets: drops sourceless, dedupes by URL, caps per kind.
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

// 13) realWorldBlock: empty research ⇒ empty string; populated ⇒ sourced + guardrail.
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

// 14) Every model call is scoped to the market, and optional capabilities stay optional.
check("withMarket scopes every model call", () => {
  let seen: InferRequest | undefined;
  const inner: ModelProvider = {
    infer: async <T>(req: InferRequest) => {
      seen = req;
      return { data: {} as T, raw: "{}", model: "fake", cached: false };
    },
  };
  const scoped = withMarket(inner, "Australia");
  void scoped.infer({ task: "t", system: "You are a coach.", messages: [] });
  assert.match(seen!.system, /^You are a coach\.\n\nMARKET: Australia\./);
  assert.match(seen!.system, /states, territories/);
  assert.equal(scoped.ragSearch, undefined, "no RAG on the inner provider ⇒ none on the wrapper");
});

// 15) Wikipedia hits must be about the field — these are real results the
//     unfiltered search returned.
check("wikipedia keeps only titles about the field", () => {
  assert.ok(titleFitsField("Nursing in Australia", "Registered Nurse"));
  assert.ok(titleFitsField("Electrician", "Electrician"));
  assert.ok(titleFitsField("Software engineer", "Backend Software Engineer"));
  assert.ok(!titleFitsField("Vehicle registration plates of Germany", "Chef"));
  assert.ok(!titleFitsField("Solar power in Australia", "Electrician"));
  assert.ok(!titleFitsField("Microsoft", "Backend Software Engineer"));
  assert.ok(!titleFitsField("Birth certificate", "Registered Nurse"));
});

// 16) The profile's target role is the goal; older records only fill gaps.
check("profile target role wins over older goal records", () => {
  const goal = resolveGoal({
    profile: { target_job_titles: ["  Electrician ", "Solar installer"], current_job_title: "Apprentice", career_level: "entry" },
    prefs: { preferred_field: "Software Engineering", seniority_level: "Senior", interview_types: ["behavioral"] },
    goalTitle: "Goal: Backend Engineer",
  });
  assert.equal(goal!.targetRole, "Electrician");
  assert.equal(goal!.targetField, "Electrician");
  assert.equal(goal!.seniority, "entry");
  assert.deepEqual(goal!.interviewTypes, ["behavioral"]);
});

check("older goal records still work without a profile role", () => {
  const goal = resolveGoal({ prefs: { preferred_field: "Nursing" }, goalTitle: "Goal: ICU nurse" });
  assert.equal(goal!.targetRole, "ICU nurse");
  assert.equal(goal!.targetField, "Nursing");
});

check("a current job is a field, never the goal", () => {
  const goal = resolveGoal({ profile: { target_job_titles: [], current_job_title: "Barista" } });
  assert.equal(goal!.targetField, "Barista");
  assert.equal(goal!.targetRole, undefined);
  assert.equal(resolveGoal({}), null);
  assert.equal(resolveGoal({ profile: { target_job_titles: ["", "  "] } }), null);
});

check("a new goal goes first in the target list, deduped and capped", () => {
  assert.deepEqual(withTargetTitleFirst(["Plumber", "electrician", "Gasfitter"], "Electrician"), ["Electrician", "Plumber", "Gasfitter"]);
  assert.equal(withTargetTitleFirst(["a", "b", "c", "d", "e", "f"], "g").length, 6);
  assert.deepEqual(withTargetTitleFirst(null, "Chef"), ["Chef"]);
});

// 17) Every level vocabulary in the product maps to the right band.
check("seniority words from every source are understood", () => {
  for (const [word, band] of [
    ["c-level", "manager"], ["exec", "manager"], ["VP", "manager"], ["director", "manager"], ["Owner", "manager"],
    ["lead", "lead"], ["principal", "lead"], ["Supervisor", "lead"],
    ["senior", "senior"],
    ["student", "junior"], ["entry", "junior"], ["Apprentice", "junior"], ["Graduate", "junior"],
    ["mid", "mid"], ["Mid-Level", "mid"], ["", "mid"],
  ] as const) {
    assert.equal(seniorityBand(word), band, `${word} → ${band}`);
  }
  // "vp" must not fire inside an ordinary word.
  assert.equal(seniorityBand("mvp builder"), "mid");
});

// 18) Smart enter: standard title + stage names, and gibberish never gets a profile.
check("profiles carry a standard title and stage names", () => {
  const p = parseFieldProfile("sparky", {
    isOccupation: true,
    canonicalTitle: "Electrician",
    levels: { entry: "Apprentice", mid: "Qualified electrician", lead: "Leading hand", wizard: "nope", vp: "" },
    keySkills: ["Wiring"],
    domainFormats: ["practical"],
  });
  assert.equal(p!.canonicalTitle, "Electrician");
  assert.deepEqual(p!.levels, { entry: "Apprentice", mid: "Qualified electrician", lead: "Leading hand" });
  assert.equal(parseFieldProfile("Chef", { keySkills: ["Knife skills"] })!.canonicalTitle, "Chef", "falls back to the input");
});

check("non-jobs get the neutral profile, marked as an answer", () => {
  const p = parseFieldProfile("asdf", { isOccupation: false, canonicalTitle: "ASDF Engineer", keySkills: ["x"], credentials: [{ name: "Fake" }] });
  assert.equal(p!.source, "neutral");
  assert.equal(p!.notOccupation, true);
  assert.equal(p!.canonicalTitle, "asdf", "no invented title");
  assert.deepEqual(p!.credentials, [], "no invented credentials");
});

// Real shapes the live model returned: booleans as strings, placeholder stages.
check("string booleans and placeholder stages are handled", () => {
  const notJob = parseFieldProfile("asdf qwerty", { isOccupation: "false", keySkills: ["x"], domainFormats: ["technical"] });
  assert.equal(notJob!.notOccupation, true, '"false" as a string still means not a job');
  const p = parseFieldProfile("sparky", {
    isOccupation: "true",
    canonicalTitle: "Electrician",
    levels: { entry: "Apprentice", vp: "Not applicable", "c-level": "N/A", director: "none" },
    keySkills: ["Wiring"],
    credentials: [{ name: "Electrician's Licence", required: "true" }, { name: "Test and Tag", required: "false" }],
  });
  assert.equal(p!.source, "model");
  assert.deepEqual(p!.levels, { entry: "Apprentice" });
  assert.deepEqual(p!.credentials.map((c) => c.required), [true, false]);
});

check("interview style reads from the profile", () => {
  assert.equal(
    describeInterviewStyle({ ...nurse, technicalWeight: 0.7, domainFormats: ["practical", "case_study"] }),
    "Interviews focus mostly on the craft, through hands-on 'walk me through it' tasks and realistic scenarios.",
  );
  assert.match(describeInterviewStyle({ ...nurse, technicalWeight: 0.3 }), /^Interviews focus mostly on how you work with people/);
});

console.log(`\nOK: ${passed} checks passed.\n`);
