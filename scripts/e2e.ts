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
      questionCount: 3,
    });
    const questions: unknown[] = Array.isArray(start.questions) ? start.questions : [];
    if (questions.length === 0) fail(`start returned no questions: ${JSON.stringify(start).slice(0, 300)}`);
    const q0 = questions[0] as any;
    const questionText: string =
      typeof q0 === "string" ? q0 : (q0?.question ?? q0?.text ?? q0?.questionText);
    if (!questionText) fail(`could not extract question text from ${JSON.stringify(q0).slice(0, 300)}`);
    console.log(`✓ start session (${questions.length} questions)`);

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
