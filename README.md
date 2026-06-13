# interview-coach-mcp

An MCP server that acts as the **brain** behind a career coach — mock interviews, study plans, cert advice, roadmaps, and tips that actually know who the learner is.

Built for [CareerCraft](https://github.com/) (the web app), but you can run it on its own, plug it into any MCP client (Cursor, Claude Desktop, etc.), or wire it into your own product.

---

## What is this, in plain English?

Most "AI interview prep" apps are just a chat box with a prompt. This is different.

This server is the **domain layer** — the part that knows:
- which skills you're weak at
- what job you're targeting
- what certs you hold (and what's expiring)
- how you scored on past mock interviews
- what resources you've actually completed

Every tool reads that context, does something useful, and writes signals back so the *next* interaction is smarter. That's the whole point.

It exposes that brain two ways:
1. **MCP** (`POST /mcp`) — for AI agents and MCP clients
2. **REST** (`POST /api/...`) — for a normal web frontend

Same logic, two doors. No duplication.

```
Your app or MCP client
        │
        │  Authorization: Bearer <user's Supabase JWT>
        ▼
  interview-coach-mcp  ──▶  Supabase (user's skills, sessions, certs, scores)
        │
        │  "generate questions", "evaluate answer", "draft tips", etc.
        ▼
  ModelProvider  ──▶  your LLM (mock / gateway / Horus)
        │
        ▼
  GroundingPort  ──▶  real sources (Hacker News, Reddit, docs) — tips aren't made up
```

---

## What can it do?

Roughly **26 tools** across five areas. You don't need to memorize them — `npm run smoke` lists everything.

| Area | What you get |
|------|----------------|
| **Interview** | Build a prep plan, generate questions, run a full mock session (start → answer → hint → next → finish), adaptive difficulty based on how you're doing |
| **Career** | Guidance, roadmaps, cert analysis/recommendations, log certs, set a career goal, refresh the AI persona from real data |
| **Study** | Week-by-week study plans, spaced-repetition drills, concept explanations, track resource progress |
| **Proof** | Tips and resources backed by *real* sources (HN threads, docs) — or flagged `unverified` if nothing credible exists |
| **Analytics** | Pattern analysis and weekly insights from actual session history — no fake metrics |

Plus **5 MCP resources** (e.g. `careercraft://learner/context`) that agents can read without calling a tool.

---

## Quick start (no API keys needed)

```bash
git clone <this-repo>
cd interview-coach-mcp
npm install

# Runs fully offline — mock AI, mock learner, no Supabase
HORUS_MODE=mock AUTH_MODE=dev npm start
```

Server starts on **http://localhost:8787**.

Try it:

```bash
npm run smoke          # lists all tools + resources over real MCP

curl -X POST http://localhost:8787/api/proven-tips \
  -H "Content-Type: application/json" \
  -d '{"skill": "System Design", "count": 3}'
```

That's it. You can explore every tool without signing up for anything.

---

## Run it for real

Copy the env file and fill in what you have:

```bash
cp .env.example .env
```

| Variable | What it does |
|----------|--------------|
| `HORUS_MODE=mock` | Fake AI responses — great for dev |
| `HORUS_MODE=gateway` | Real generation via OpenAI-compatible API (Gemini, etc.), key in `.env` |
| `HORUS_MODE=http` | Real generation via the deployed Supabase `infer` function (key stays a server secret) — or a future Horus `/infer` |
| `GROUNDING_MODE=hn` | Real Hacker News sources (free, no key) |
| `GROUNDING_MODE=mock` | Canned proof sources |
| `SUPABASE_URL` + `SUPABASE_ANON_KEY` | Real user data, RLS-scoped |
| `AUTH_MODE=dev` | Skip auth, use a fake learner — **local only, never prod** |

**With CareerCraft's web UI** (both repos): the `.env` is already configured for the real path — generation goes through the deployed Supabase `infer` function (which holds the model key as a secret), so there's no key to add here.

```bash
# interview-coach-mcp/.env  (already set)
HORUS_MODE=http
HORUS_BASE_URL=https://<project>.supabase.co/functions/v1
HORUS_API_KEY=<shared secret, = INFER_SHARED_SECRET on Supabase>
GROUNDING_MODE=hn
SUPABASE_URL=<your supabase url>
SUPABASE_ANON_KEY=<your anon key>
CORS_ORIGIN=http://localhost:8080

npm start   # :8787 — real Supabase data + real Gemini, no local model key

# careercraft-pages/packages/careercraft-web/.env.local (already set)
#   VITE_INTERVIEW_MCP_URL=http://localhost:8787
npm run dev:web   # :8080 → sign in, open Interview Prep → Career Development
```

If the MCP isn't reachable, the UI shows "not available" — it won't silently fall back to fake data.

---

## How auth works

The caller sends a **Supabase JWT** in the `Authorization` header. The server verifies it, opens an RLS-scoped DB client, and uses *that user's* data.

Important: the server **never trusts a `userId` passed in the tool body**. Identity always comes from the token. That's on purpose.

In dev mode (`AUTH_MODE=dev`), auth is skipped and you get a canned learner profile so you can click through everything without logging in.

---

## How the AI layer works (the one rule)

This repo **never imports OpenAI, Anthropic, or Gemini directly**.

All generation goes through one interface — `ModelProvider` (`src/adapters/horus/port.ts`):

```ts
await horus.infer({
  task: "interview.evaluate_answer",
  system: "...your expert rubric prompt...",
  messages: [{ role: "user", content: user }],
  model: "deep",   // "fast" | "deep" — routing tier, not a model name
  userRef: auth.userId,
});
```

Swap the adapter in `src/adapters/horus/index.ts` and the whole server works with your LLM. Nothing else changes.

Same idea for sources: `GroundingPort` (`src/adapters/grounding/port.ts`) — the model *proposes* tips, grounding *proves* them.

---

## Project layout (if you want to contribute)

```
src/
├── server.ts              ← HTTP entry (MCP + REST)
├── server/build-server.ts ← registers all tools per request
├── tools/                 ← one file per area (interview, career, study, proof, analytics)
├── context/assemble.ts    ← pulls learner profile from DB into one object
├── domain/                ← pure logic: adaptive difficulty, prompts, cert catalog, SM-2 scheduling
├── adapters/
│   ├── horus/             ← ModelProvider (mock / gateway / http)
│   └── grounding/         ← GroundingPort (mock / HN / reddit / http)
└── schemas.ts             ← Zod validation for tool inputs
```

**Good first contributions:**
- Add a tool in `src/tools/` and register it in `build-server.ts` + a REST route in `server.ts`
- Improve prompts in `src/domain/prompts.ts`
- Add a new grounding source in `src/adapters/grounding/`
- Unit tests for pure functions in `src/domain/` (no mocks needed)

PRs welcome. If you're not sure where something fits, open an issue first — happy to point you in the right direction.

---

## REST routes (for web apps)

Every route maps 1:1 to an MCP tool. Full list:

| Route | Tool |
|-------|------|
| `POST /api/interview/plan` | `build_interview_plan` |
| `POST /api/interview/questions` | `generate_contextual_questions` |
| `POST /api/interview/start` | `start_interview_session` |
| `POST /api/interview/answer` | `submit_answer` |
| `POST /api/interview/next` | `next_question` |
| `POST /api/interview/hint` | `get_interview_hint` |
| `POST /api/interview/finish` | `finish_interview` |
| `POST /api/career/guidance` | `career_guidance` |
| `POST /api/career/roadmap` | `build_career_roadmap` |
| `POST /api/career/goal` | `set_career_goal` |
| `POST /api/career/profile` | `get_career_profile` |
| `POST /api/career/persona/refresh` | `refresh_persona` |
| `POST /api/career/certifications/analyze` | `analyze_certifications` |
| `POST /api/career/certifications/recommend` | `recommend_certifications` |
| `POST /api/career/certifications/log` | `log_certification` |
| `POST /api/study/plan` | `build_study_plan` |
| `POST /api/study/drill` | `next_drill` |
| `POST /api/study/drill/result` | `record_drill_result` |
| `POST /api/study/explain` | `explain_concept` |
| `POST /api/study/resource/progress` | `track_resource_progress` |
| `POST /api/proven-tips` | `get_proven_tips` |
| `POST /api/resources` | `find_proven_resources` |
| `POST /api/resources/rank` | `rank_learning_resources` |
| `POST /api/recommendations/explain` | `explain_recommendation` |
| `POST /api/analytics/patterns` | `analyze_patterns` |
| `POST /api/analytics/weekly` | `weekly_insight` |

MCP endpoint: `POST /mcp` · Health check: `GET /health`

---

## Personalization (why it's not just a prompt)

Every interaction feeds back into the learner profile:

1. **Signals in** — interview answers, drill scores, logged certs, completed resources, session streaks
2. **One context object** — `assembleLearnerContext()` merges skills, certs, goal, job pipeline, scores, patterns
3. **Everything uses it** — questions target weak skills, roadmaps start from real proficiencies, cert advice knows what's expiring
4. **`refresh_persona`** — periodically rewrites the long-term AI persona from all of the above

No hidden cache. It's all in Postgres, scoped to the user via RLS.

---

## Database

Reads/writes CareerCraft's existing Supabase tables — `interview_*`, `user_skills`, `user_certifications`, `score_history`, `learning_resources`, etc. **No new tables required** to run against an existing CareerCraft project.

Persistence calls are best-effort: if a column is missing or the schema differs, the tool still returns a useful response — it just might not save that particular field.

---

## Known limitations

- **Horus** doesn't expose a generic `/infer` endpoint yet, so generation is bridged today by the deployed Supabase `infer` function (`HORUS_MODE=http`, real Gemini, model key stays a server secret). When Horus ships `/infer`, repoint `HORUS_BASE_URL` and delete the function. (`gateway`/`mock` modes still available.)
- **Grounding bridge** (Reddit MCP + web search + Horus RAG composed together) isn't wired yet — HN client works today.
- **Voice interviews** (`interview.voice`) — not built yet.
- **Calendar export** for roadmap weekly blocks — not built yet.

---

## Scripts

```bash
npm start       # run the server
npm run dev     # run with hot reload
npm run smoke   # MCP protocol smoke test
npm run typecheck
```

Requires **Node 18+**.

---

## License

Private / all rights reserved unless otherwise noted. Open an issue if you want to use this commercially or need a different license.
