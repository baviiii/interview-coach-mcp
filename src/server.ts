import { randomUUID } from "node:crypto";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, { type Request, type Response } from "express";

import { getGrounding } from "./adapters/grounding/index.js";
import { getModelProvider } from "./adapters/horus/index.js";
import { getResearch } from "./adapters/research/index.js";
import { config } from "./config.js";
import { AppError } from "./errors.js";
import { authenticate, extractBearer, type AuthContext } from "./server/auth.js";
import { buildServer } from "./server/build-server.js";
import { rateLimit } from "./server/rate-limit.js";
import type { ToolDeps } from "./tools/interview.js";

// AUTH_MODE=dev serves a canned identity with no verification — an open
// server. Refuse to boot rather than let a misconfigured deploy go live.
const isProd = process.env.NODE_ENV === "production";
if (isProd && process.env.AUTH_MODE === "dev") {
  console.error("FATAL: AUTH_MODE=dev bypasses all auth and must never run with NODE_ENV=production.");
  process.exit(1);
}
if (isProd && (process.env.CORS_ORIGIN === undefined || process.env.CORS_ORIGIN === "*")) {
  console.warn("WARNING: CORS_ORIGIN is '*' in production — set it to your web app's origin.");
}

const app = express();
app.use(express.json({ limit: "2mb" }));

// CORS — permissive for local dev; set CORS_ORIGIN to your app origin in prod.
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", config.corsOrigin);
  res.header("Access-Control-Allow-Headers", "authorization, content-type");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS, DELETE");
  if (req.method === "OPTIONS") {
    res.sendStatus(204);
    return;
  }
  next();
});

// One line per request so prod has a trail: route, status, duration.
app.use((req, res, next) => {
  if (req.path === "/health") return next();
  const startedAt = Date.now();
  res.on("finish", () => {
    console.log(`${req.method} ${req.path} ${res.statusCode} ${Date.now() - startedAt}ms`);
  });
  next();
});

app.use(["/mcp", "/api"], rateLimit({ windowMs: config.limits.rateWindowMs, max: config.limits.rateMax }));

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    name: "interview-coach-mcp",
    horus: config.horus.mode,
    grounding: config.grounding.mode,
    research: config.research.mode,
  });
});

// ── MCP surface (for agents / the turnkey sale) ───────────────────────────
app.post("/mcp", async (req, res) => {
  try {
    const auth = await resolveAuth(req.headers["authorization"]);
    const server = buildServer({ auth, horus: getModelProvider(), grounding: getGrounding(), research: getResearch() });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    sendErr(res, e);
  }
});
app.get("/mcp", (_req, res) => res.status(405).json({ error: "Method not allowed (stateless)" }));
app.delete("/mcp", (_req, res) => res.status(405).json({ error: "Method not allowed (stateless)" }));

// ── REST surface (for CareerCraft's own UI) — SAME brain, simpler shape ────
// Each route runs the corresponding MCP tool in-process (no logic duplication).
const rest = (tool: string) => async (req: Request, res: Response) => {
  try {
    const auth = await resolveAuth(req.headers["authorization"]);
    const deps: ToolDeps = { auth, horus: getModelProvider(), grounding: getGrounding(), research: getResearch() };
    res.json(await callTool(deps, tool, (req.body as Record<string, unknown>) ?? {}));
  } catch (e) {
    sendErr(res, e);
  }
};
app.post("/api/interview/plan", rest("build_interview_plan"));
app.post("/api/interview/questions", rest("generate_contextual_questions"));
app.post("/api/interview/start", rest("start_interview_session"));
app.post("/api/interview/answer", rest("submit_answer"));
app.post("/api/interview/next", rest("next_question"));
app.post("/api/interview/hint", rest("get_interview_hint"));
app.post("/api/interview/finish", rest("finish_interview"));
app.post("/api/proven-tips", rest("get_proven_tips"));
app.post("/api/resources", rest("find_proven_resources"));
app.post("/api/resources/rank", rest("rank_learning_resources"));
app.post("/api/learning/pathway", rest("get_learning_pathway"));
app.post("/api/recommendations/explain", rest("explain_recommendation"));
app.post("/api/analytics/patterns", rest("analyze_patterns"));
app.post("/api/analytics/weekly", rest("weekly_insight"));

// Career guidance + certification intelligence
app.post("/api/career/guidance", rest("career_guidance"));
app.post("/api/career/roadmap", rest("build_career_roadmap"));
app.post("/api/career/goal", rest("set_career_goal"));
app.post("/api/career/profile", rest("get_career_profile"));
app.post("/api/career/persona/refresh", rest("refresh_persona"));
app.post("/api/career/certifications/analyze", rest("analyze_certifications"));
app.post("/api/career/certifications/recommend", rest("recommend_certifications"));
app.post("/api/career/certifications/log", rest("log_certification"));

// Study engine (plans, spaced-repetition drills, explanations, progress)
app.post("/api/study/plan", rest("build_study_plan"));
app.post("/api/study/drill", rest("next_drill"));
app.post("/api/study/drill/result", rest("record_drill_result"));
app.post("/api/study/explain", rest("explain_concept"));
app.post("/api/study/resource/progress", rest("track_resource_progress"));

app.listen(config.port, () => {
  console.log(
    `interview-coach-mcp listening on :${config.port} (horus=${config.horus.mode}, grounding=${config.grounding.mode}, research=${config.research.mode})`,
  );
});

/** Invoke a registered MCP tool in-process and return its parsed JSON payload. */
async function callTool(deps: ToolDeps, name: string, args: Record<string, unknown>): Promise<unknown> {
  const server = buildServer(deps);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "rest-bridge", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const result = await client.callTool({ name, arguments: args });
    const content = (result.content ?? []) as Array<{ type: string; text?: string }>;
    const text = content.find((c) => c.type === "text")?.text;
    if (result.isError) throw new AppError(text ?? "Tool error", 400);
    return text ? JSON.parse(text) : null;
  } finally {
    await client.close();
    await server.close();
  }
}

function sendErr(res: Response, e: unknown) {
  const status = e instanceof AppError ? e.status : 500;
  if (!res.headersSent) {
    res.status(status).json({ error: e instanceof Error ? e.message : "Internal error" });
  }
}

/**
 * AUTH_MODE=dev bypasses Supabase verification AND makes context demo-canned
 * (see context/assemble.ts), so the whole server runs end-to-end with no
 * credentials. Never enable in production.
 */
async function resolveAuth(header: string | undefined): Promise<AuthContext> {
  if (process.env.AUTH_MODE === "dev") {
    const throwingDb = new Proxy({}, { get() { throw new Error("DB unavailable in AUTH_MODE=dev"); } });
    return { userId: `dev-${randomUUID()}`, email: null, jwt: "dev", db: throwingDb as never };
  }
  return authenticate(extractBearer(header));
}
