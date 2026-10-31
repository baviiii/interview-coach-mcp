/**
 * E2E golden path: boots the server fully offline (mock AI, mock research,
 * mock grounding, dev auth) and walks the loop a real user hits:
 *
 *   health → MCP list tools → start session → submit answer → finish
 *   → proven tips → rate limit trips at RATE_LIMIT_MAX.
 *
 * No network, no keys, no DB. Run directly (`npm run e2e`) — it spawns its
 * own server on E2E_PORT (default 8790) and tears it down after.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const require = createRequire(import.meta.url);
const PORT = Number(process.env.E2E_PORT ?? 8790);
const BASE = `http://localhost:${PORT}`;
const RATE_MAX = 30; // low enough to trip within the test, high enough for the flow

function fail(msg: string): never {
  console.error(`\nE2E FAILED: ${msg}`);
  process.exit(1);
}

async function post(path: string, body: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer dev" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* non-JSON error body */
  }
  return { status: res.status, json };
}

async function mustPost(path: string, body: unknown): Promise<any> {
  const { status, json } = await post(path, body);
  if (status !== 200) fail(`${path} → ${status}: ${JSON.stringify(json).slice(0, 300)}`);
  return json;
}

async function waitForHealth(timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  fail("server did not become healthy within 30s");
}

async function main() {
  const server = spawn(process.execPath, [require.resolve("tsx/cli"), "src/server.ts"], {
    env: {
      ...process.env,
      PORT: String(PORT),
      AUTH_MODE: "dev",
      HORUS_MODE: "mock",
      GROUNDING_MODE: "mock",
      RESEARCH_MODE: "mock",
      RATE_LIMIT_MAX: String(RATE_MAX),
      NODE_ENV: "test",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stderr.on("data", (d: Buffer) => process.stderr.write(`[server] ${d}`));
  server.on("exit", (code) => {
    if (!finished) fail(`server exited early (code ${code})`);
  });
  let finished = false;

  try {
    await waitForHealth();
    console.log("✓ health");

    // MCP surface: a real client can connect and see the full toolset.
    const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
      requestInit: { headers: { Authorization: "Bearer dev" } },
    });
    const client = new Client({ name: "e2e", version: "0.0.0" });
    await client.connect(transport);
    const tools = await client.listTools();
    await client.close();
    if (tools.tools.length < 20) fail(`expected ≥20 MCP tools, got ${tools.tools.length}`);
    console.log(`✓ MCP list tools (${tools.tools.length})`);

    // Golden path over REST. Dev mode has no DB, so sessionId comes back null
    // and the loop runs stateless — the client supplies a UUID (writes are
    // best-effort by design).
    const start = await mustPost("/api/interview/start", {
      field: "Software Engineering",
      seniority: "Mid-Level",
      questionCount: 6,
    });
    const questions: unknown[] = Array.isArray(start.questions) ? start.questions : [];
    if (questions.length === 0) fail(`start returned no questions: ${JSON.stringify(start).slice(0, 300)}`);
    const q0 = questions[0] as any;
    const questionText: string =
      typeof q0 === "string" ? q0 : (q0?.question ?? q0?.text ?? q0?.questionText);
    if (!questionText) fail(`could not extract question text from ${JSON.stringify(q0).slice(0, 300)}`);
    console.log(`✓ start session (${questions.length} questions)`);

    // A full loop is structured, and behavioural coverage is guaranteed by the
    // blueprint — not left to the model's discretion.
    const blueprint: any[] = Array.isArray(start.blueprint) ? start.blueprint : [];
    const plannedBehavioral = blueprint.filter((s) => s?.stage === "behavioral").length;
    if (plannedBehavioral < 2) {
      fail(`blueprint planned only ${plannedBehavioral} behavioral slots: ${JSON.stringify(blueprint).slice(0, 300)}`);
    }
    const behavioral = questions.filter((q: any) => q?.type === "behavioral" || q?.stage === "behavioral");
    if (behavioral.length < 2) {
      fail(`expected ≥2 behavioral questions, got ${behavioral.length}`);
    }
    const unstaged = questions.filter((q: any) => !q?.stage || !q?.whyThisQuestion);
    if (unstaged.length > 0) {
      fail(`every question needs a stage and whyThisQuestion; ${unstaged.length} missing`);
    }
    console.log(`✓ full loop is structured (${plannedBehavioral} behavioral slots, all questions staged)`);

    const sessionId = start.sessionId ?? randomUUID();
    const answer = await mustPost("/api/interview/answer", {
      sessionId,
      questionText,
      answerText:
        "I would clarify requirements first, outline the approach, then walk through trade-offs with a concrete example from a past project.",
      field: "Software Engineering",
      seniority: "Mid-Level",
    });
    if (!answer.evaluation) fail(`answer returned no evaluation: ${JSON.stringify(answer).slice(0, 300)}`);
    console.log("✓ submit answer (evaluated)");

    const finish = await mustPost("/api/interview/finish", {
      sessionId,
      field: "Software Engineering",
    });
    if (!finish || typeof finish !== "object") fail("finish returned nothing");
    console.log("✓ finish session");

    // A phone screen is its own round: recruiter questions in recruiter order,
    // answers checked for length, and a put-forward call at the end.
    const screen = await mustPost("/api/interview/start", {
      field: "Payroll Officer",
      questionCount: 1,
      plannedCount: 4,
      roundType: "screen",
    });
    const screenPlan: any[] = Array.isArray(screen.blueprint) ? screen.blueprint : [];
    const screenParts = screenPlan.map((s) => s?.type).join(",");
    if (screenParts !== "pitch,motivation,experience,salary") fail(`screen planned ${screenParts}`);
    const opener = Array.isArray(screen.questions) ? screen.questions : [];
    if (opener.length !== 1 || opener[0]?.type !== "pitch" || opener[0]?.targetWords?.max !== 225) {
      fail(`a realistic screen must open on the pitch, with its length band: ${JSON.stringify(opener).slice(0, 300)}`);
    }
    const screenAnswer = await mustPost("/api/interview/answer", {
      sessionId: screen.sessionId ?? randomUUID(),
      questionText: opener[0].question,
      questionType: "pitch",
      answerText: "Payroll officer, four years, looking for a bigger team.",
      field: "Payroll Officer",
      roundType: "screen",
    });
    if (!screenAnswer.evaluation) fail("screen answer returned no evaluation");
    const screenFinish = await mustPost("/api/interview/finish", {
      sessionId: screen.sessionId ?? randomUUID(),
      field: "Payroll Officer",
      roundType: "screen",
      plannedCount: 4,
      durationSeconds: 300,
    });
    if (screenFinish.roundType !== "screen" || !screenFinish.evaluation?.screenVerdict) {
      fail(`screen debrief needs a put-forward call: ${JSON.stringify(screenFinish).slice(0, 300)}`);
    }
    console.log(`✓ phone screen (${screenParts}; verdict "${screenFinish.evaluation.screenVerdict}")`);

    const stories = await mustPost("/api/interview/start", { field: "Payroll Officer", questionCount: 6, roundType: "behavioral" });
    const storyStages = new Set((stories.questions ?? []).map((q: any) => q?.stage));
    if (storyStages.has("domain") || storyStages.has("situational")) {
      fail(`a behavioural round asked craft questions: ${[...storyStages].join(",")}`);
    }
    console.log(`✓ behavioural round has no craft questions (${[...storyStages].join(", ")})`);

    // The score shows its working: dimensions × weights, and STAR highlights
    // located in the answer itself. A retry reports the change.
    const storyQ = (stories.questions ?? [])[1];
    const storyAnswer =
      "Last year our weekly reporting pack took two full days to build by hand. I mapped every step, rebuilt the data pull in Python and automated the template, and the pack now takes half a day.";
    const scored = await mustPost("/api/interview/answer", {
      sessionId: randomUUID(),
      questionText: storyQ?.question ?? "Tell me about a time you owned something.",
      questionType: "behavioral",
      answerText: storyAnswer,
      field: "Payroll Officer",
      roundType: "behavioral",
      attempt: 2,
      previousAnswer: "We fixed the report.",
      previousScore: 4,
    });
    const build = scored.scoring;
    if (!build || !Array.isArray(build.dimensions) || build.dimensions.length !== 4 || typeof build.final !== "number") {
      fail(`answer must return its score build: ${JSON.stringify(scored).slice(0, 300)}`);
    }
    if (scored.evaluation?.score !== build.final) fail("the evaluation's score must be the built score");
    const hl = scored.highlights ?? [];
    if (!hl.length || hl.some((h: any) => storyAnswer.slice(h.start, h.end).length < 8)) {
      fail(`STAR highlights must point into the answer: ${JSON.stringify(hl)}`);
    }
    if (scored.ownership?.i !== 1 || scored.ownership?.we !== 1) fail(`ownership miscounted: ${JSON.stringify(scored.ownership)}`);
    if (scored.improvement?.from !== 4 || scored.improvement?.to !== build.final) fail("a retry must report its change");
    console.log(`✓ score shows its working (${build.final}/10 from 4 dimensions, ${hl.length} STAR highlights, retry 4 → ${build.final})`);

    const fixed = await mustPost("/api/interview/start", {
      field: "Payroll Officer",
      roundType: "screen",
      fixedQuestions: [{ question: "What are you after salary-wise — base or package plus super?", type: "salary" }],
    });
    const fq = fixed.questions?.[0];
    if (fixed.questions?.length !== 1 || fq?.stage !== "screen" || fq?.targetWords?.max !== 110) {
      fail(`a fixed question must be asked as given, with its rules: ${JSON.stringify(fixed).slice(0, 300)}`);
    }
    console.log("✓ practise a question again (asked as given, salary rules kept)");

    const ksc = await mustPost("/api/interview/selection-criterion", {
      criterion: "Demonstrated ability to deliver results in a fast-paced environment.",
      wordLimit: 250,
    });
    if (typeof ksc.draft !== "string" || typeof ksc.wordCount !== "number" || ksc.wordLimit !== 250 || typeof ksc.overLimit !== "boolean") {
      fail(`selection criterion draft incomplete: ${JSON.stringify(ksc).slice(0, 300)}`);
    }
    console.log(`✓ selection criterion drafted (${ksc.wordCount}/${ksc.wordLimit} words, counted)`);

    // Voice needs Horus: in mock mode it must say so, not crash.
    const voice = await post("/api/voice/session", {});
    if (voice.status !== 503) fail(`voice without Horus should be 503, got ${voice.status}`);
    console.log("✓ voice reports unavailable without Horus (503)");

    const tips = await mustPost("/api/proven-tips", { skill: "System Design", count: 2 });
    if (!tips) fail("proven-tips returned nothing");
    console.log("✓ proven tips");

    // The learning side must work for a learner with nothing in the database:
    // no tracked skills, no resources table, no prior interview.
    const plan = await mustPost("/api/study/plan", { weeks: 2, hoursPerWeek: 4 });
    if (!plan.plan || !Array.isArray(plan.targets) || plan.targets.length === 0) {
      fail(`study plan came back empty for a cold-start learner: ${JSON.stringify(plan).slice(0, 300)}`);
    }
    console.log(`✓ study plan on cold start (targets from ${plan.targetSource})`);

    const ranked = await mustPost("/api/resources/rank", { goal: "Senior Backend Engineer", maxResults: 4 });
    if (!Array.isArray(ranked.resources) || ranked.resources.length === 0) {
      fail(`resource ranking returned nothing with an empty catalogue: ${JSON.stringify(ranked).slice(0, 300)}`);
    }
    console.log(`✓ resources with an empty catalogue (${ranked.resources.length}, unsourced=${ranked.unsourced})`);

    const pathway = await mustPost("/api/learning/pathway", { field: "Software Engineering", weeks: 2 });
    const p = pathway.pathway;
    if (!p || !Array.isArray(p.targets) || p.targets.length === 0) {
      fail(`pathway returned no targets: ${JSON.stringify(pathway).slice(0, 300)}`);
    }
    if (!p.plan || !Array.isArray(p.resources) || !p.nextDrill?.skill || !p.nextMock?.field) {
      fail(`pathway is missing a section: ${JSON.stringify(Object.keys(p))}`);
    }
    if (!pathway._meta?.degraded) fail("pathway must report its degraded state");
    console.log(`✓ learning pathway (${p.targets.length} targets, ${p.resources.length} resources)`);

    // Smart enter: what someone typed comes back as a job they can confirm.
    const preview = await mustPost("/api/career/field-preview", { field: "sparky" });
    if (!preview.known || !preview.canonicalTitle || !preview.interviewStyle) {
      fail(`field preview incomplete: ${JSON.stringify(preview)}`);
    }
    console.log(`✓ field preview ("sparky" → ${preview.canonicalTitle}, ${Object.keys(preview.levels).length} stage names)`);

    // A written drill answer is marked by the coach, not self-rated: one of
    // two points covered, with the quote found in the answer → 5/10.
    const drill = {
      prompt: "Design a rate limiter for a public API and say where its state lives.",
      type: "hands_on",
      difficulty: "medium",
      idealAnswerPoints: ["Names token bucket vs sliding window", "Places the state and its hot-key risk"],
    };
    const marked = await mustPost("/api/study/drill/result", {
      skill: "System Design",
      drill,
      answerText: "I would use a token bucket per API key, refilled at a fixed rate.",
      score: 10,
    });
    if (marked.scoredBy !== "coach") fail(`a written drill answer wasn't marked by the coach: ${JSON.stringify(marked)}`);
    const marks = (marked.evaluation?.points ?? []).map((pt: { mark: string }) => pt.mark).join(",");
    if (marks !== "covered,missing" || marked.score !== 5) {
      fail(`drill marks/score wrong (${marks}, ${marked.score}): ${JSON.stringify(marked.evaluation)}`);
    }
    if (!marked.evaluation.points[0].quote?.text) fail("a covered drill point carries no quote from the answer");
    const selfRated = await mustPost("/api/study/drill/result", { skill: "System Design", score: 7 });
    if (selfRated.scoredBy !== "self" || selfRated.score !== 7 || selfRated.evaluation !== null) {
      fail(`a self-rated drill changed: ${JSON.stringify(selfRated)}`);
    }
    console.log(`✓ drill marked by the coach (${marks} → ${marked.score}/10; self-rating ignored), self-rating still works`);

    // Any link can be tracked, not just catalogue rows (dev mode has no DB, so
    // nothing persists; the request shape and the link's identity are checked).
    const tracked = await mustPost("/api/study/resource/progress", {
      url: "https://example.com/guide/#part-2",
      title: "A guide",
      skill: "System Design",
      status: "completed",
    });
    if (tracked.url !== "https://example.com/guide" || tracked.status !== "completed" || tracked.resourceId !== null) {
      fail(`link tracking returned the wrong link: ${JSON.stringify(tracked)}`);
    }
    const neither = await post("/api/study/resource/progress", { status: "saved" });
    if (neither.status !== 400) {
      fail(`tracking with neither a resource nor a link should be refused: ${JSON.stringify(neither.json)}`);
    }
    console.log("✓ a link can be tracked (normalised), and a request with no resource is refused");

    // The cost guard actually guards: hammer until 429.
    let tripped = false;
    for (let i = 0; i < RATE_MAX + 5; i++) {
      const { status } = await post("/api/proven-tips", { skill: "Testing", count: 1 });
      if (status === 429) {
        tripped = true;
        break;
      }
    }
    if (!tripped) fail(`rate limit never tripped within ${RATE_MAX + 5} extra requests`);
    console.log("✓ rate limit trips at the cap");

    finished = true;
    console.log("\nOK: e2e golden path passed.");
  } finally {
    finished = true;
    server.kill();
  }
}

main().catch((e) => fail(e instanceof Error ? e.stack ?? e.message : String(e)));
