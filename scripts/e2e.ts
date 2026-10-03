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
