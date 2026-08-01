/** Proves the generation pipeline runs: prompt builder → Horus port → parsed
 *  structured JSON. Uses the mock Horus, no DB/auth needed. */
import { MockHorusClient } from "../src/adapters/horus/mock-client.js";
import { interviewBlueprint } from "../src/domain/interview-loop.js";
import { evaluateAnswerPrompt, generateQuestionsPrompt } from "../src/domain/prompts.js";

const horus = new MockHorusClient();

const blueprint = interviewBlueprint({ field: "Software Engineering", seniority: "Senior", questionCount: 4 });
console.log(
  "blueprint →",
  blueprint.slots.map((s) => `${s.index}:${s.stage}/${s.type}/${s.difficulty}`).join("  "),
);

const gq = generateQuestionsPrompt({ blueprint });
const q = await horus.infer<{ questions: unknown[] }>({
  task: "interview.generate_questions",
  system: gq.system,
  messages: [{ role: "user", content: gq.user }],
  model: "deep",
});
console.log("generate_questions → questions returned:", q.data.questions.length, "| model:", q.model);

const ev = evaluateAnswerPrompt({
  field: "Software Engineering",
  question: "Design a URL shortener.",
  answer: "I'd hash the URL and store the mapping in a key-value store.",
});
const e = await horus.infer<{ score: number; suggestedFollowup: string }>({
  task: "interview.evaluate_answer",
  system: ev.system,
  messages: [{ role: "user", content: ev.user }],
  model: "deep",
});
console.log("evaluate_answer → score:", e.data.score, "| followup:", e.data.suggestedFollowup);
console.log("\nPipeline OK: structured JSON parsed from Horus.");
