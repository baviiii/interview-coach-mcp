/**
 * Does the score mean anything? Run against the REAL model before changing a
 * rubric or an evaluation prompt:
 *
 *   HORUS_MODE=http HORUS_BASE_URL=… HORUS_API_KEY=… npm run score-check
 *
 * For each kind of question it scores a strong and a weak answer three times
 * and checks that:
 *   - the strong answer beats the weak one by at least 2 points (the score
 *     separates good from bad, which is the whole point of it);
 *   - the same answer never moves more than 1.5 points between runs (a learner
 *     who retries word-for-word shouldn't see a different verdict);
 *   - a strong story's STAR quotes are found in the answer (the highlights
 *     are real, not paraphrases).
 *
 * Not part of CI: it needs a model key and costs a few cents a run. In mock
 * mode it refuses rather than passing on canned scores.
 */
import { getModelProvider } from "../src/adapters/horus/index.js";
import { config } from "../src/config.js";
import { evaluateAnswerPrompt } from "../src/domain/prompts.js";
import { buildScore, locateQuotes, ownershipCounts, rubricFor } from "../src/domain/scoring.js";

if (config.horus.mode === "mock") {
  console.error("score-check needs a real model: set HORUS_MODE=http (or gateway) and its credentials.");
  process.exit(2);
}

interface Case {
  name: string;
  field: string;
  type: string;
  question: string;
  strong: string;
  weak: string;
}

const CASES: Case[] = [
  {
    name: "behavioural story",
    field: "Data Analyst",
    type: "behavioral",
    question: "Tell me about a time you took ownership of a problem nobody else was fixing.",
    strong:
      "At SA Water the weekly operations report took two analysts two full days, and errors were reaching the executive team. Nobody owned it, so I asked my manager if I could. I mapped every manual step, rebuilt the data pull in SQL, and automated the Power BI refresh. I also wrote a one-page check list and trained the two analysts. The report now takes half a day, and in six months we haven't had a single correction sent to the executives. I learned to measure where the time actually goes before I start fixing anything.",
    weak: "We had a report that was slow, so we worked on it as a team and made it better. Everyone was happy with it in the end.",
  },
  {
    name: "phone-screen salary",
    field: "Payroll Officer",
    type: "salary",
    question: "What are you looking for salary-wise?",
    strong:
      "From what I've seen for payroll officers in Adelaide with four years' experience, I'm looking at 78 to 85 thousand base, plus super. I'm flexible within that for the right team, and I'd like to hear the budget for the role too.",
    weak: "I don't really mind, whatever you think is fair.",
  },
  {
    name: "technical",
    field: "Data Analyst",
    type: "technical",
    question: "How would you find and handle duplicate customer records in a large table?",
    strong:
      "First I'd define what a duplicate means here, because exact matches miss most of them: I'd normalise names, emails and phone numbers, then group on the normalised email and a fuzzy name match. I'd use ROW_NUMBER over that grouping ordered by last-updated to pick a survivor, and keep a mapping table from merged IDs to the survivor so orders and history still join. I wouldn't delete anything until the mapping is checked on a sample with the business, because a false merge is worse than a missed duplicate.",
    weak: "I would use DISTINCT in SQL to remove the duplicates.",
  },
];

const RUNS = 3;
const provider = getModelProvider();

async function score(c: Case, answer: string) {
  const rubric = rubricFor(c.type);
  const { system, user } = evaluateAnswerPrompt({
    field: c.field,
    question: c.question,
    questionType: c.type,
    answer,
    ownership: rubric.star ? ownershipCounts(answer) : null,
  });
  const res = await provider.infer<Record<string, unknown>>({
    task: "interview.evaluate_answer",
    system,
    messages: [{ role: "user", content: user }],
    model: "deep",
    temperature: 0.2,
  });
  const build = buildScore(rubric, res.data.scoreBreakdown, res.data.cap, res.data.score);
  return { final: build.final, highlights: rubric.star ? locateQuotes(answer, res.data.starQuotes).length : null };
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const spread = (xs: number[]) => Math.max(...xs) - Math.min(...xs);

let failures = 0;
for (const c of CASES) {
  const strong = await Promise.all(Array.from({ length: RUNS }, () => score(c, c.strong)));
  const weak = await Promise.all(Array.from({ length: RUNS }, () => score(c, c.weak)));
  const s = strong.map((r) => r.final);
  const w = weak.map((r) => r.final);
  const gap = mean(s) - mean(w);
  const problems: string[] = [];
  if (gap < 2) problems.push(`strong only beats weak by ${gap.toFixed(1)} (need ≥ 2)`);
  if (spread(s) > 1.5) problems.push(`strong answer moved ${spread(s).toFixed(1)} between runs`);
  if (spread(w) > 1.5) problems.push(`weak answer moved ${spread(w).toFixed(1)} between runs`);
  if (strong[0]!.highlights !== null && strong.some((r) => (r.highlights ?? 0) < 2)) {
    problems.push("a strong story's STAR quotes weren't found in the answer");
  }
  failures += problems.length;
  console.log(
    `${problems.length ? "✗" : "✓"} ${c.name}: strong ${s.join(" / ")}, weak ${w.join(" / ")} (gap ${gap.toFixed(1)})${
      problems.length ? `\n    ${problems.join("\n    ")}` : ""
    }`,
  );
}

if (failures) {
  console.error(`\nscore-check: ${failures} problem(s). Fix the rubric or prompt before shipping it.`);
  process.exit(1);
}
console.log("\nscore-check: scores separate good from weak and hold steady between runs.");
