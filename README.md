# interview-coach-mcp

An MCP server that acts as the **brain** behind a career coach — mock interviews, study plans, cert advice, roadmaps, and tips that know who the learner is (when Supabase is wired up).

Built for [CareerCraft](https://github.com/) (the web app), but you can run it on its own, plug it into any MCP client (Cursor, Claude Desktop, etc.), or wire it into your own product.

**Be honest about scope:** this is strongest as a **structured coach for tech-ish careers** (software, DevOps, data, PM). Other fields can work for **mock interviews if you pass a job description** — but cert catalogs, career paths, and proof sources are still tech-biased today. See [What's hardcoded vs dynamic](#whats-hardcoded-vs-dynamic) and [External sources](#external-sources-whats-actually-connected).

---

## What is this, in plain English?

Most "AI interview prep" apps are just a chat box with a prompt. This one adds:

- a **learner profile** (skills, scores, certs, goals) from the database
- a **session loop** (start → answer → hint → next → finish) with adaptive difficulty
- **persistence** so the next session can target weak areas
- optional **source links** on tips (Hacker News / Reddit) — not full web research

It exposes that brain two ways:

1. **MCP** (`POST /mcp`) — for AI agents and MCP clients
2. **REST** (`POST /api/...`) — for a normal web frontend

Same logic, two doors. No duplication.

```
Your app or MCP client
        │
        │  Authorization: Bearer <user's Supabase JWT>
        ▼
  interview-coach-mcp  ──▶  Supabase (skills, sessions, certs, scores, resources)
        │
        │  generate / evaluate / plan / drill …
        ▼
  ModelProvider  ──▶  LLM (mock / gateway / Horus HTTP)
        │
        ▼
  GroundingPort  ──▶  HN or Reddit (proof links on tips — after the AI writes them)
```

---

## Glossary

| Term | Meaning |
|------|---------|
| **JD** | **Job description** — the text of a job posting (requirements, responsibilities). Paste it into tools or pick a saved job from CareerCraft. This is the main way to prep for a **specific role** (e.g. "ICU nurse" at Hospital X) without relying on hardcoded career paths. |
| **Field** | Broad career label you pass in, e.g. `"Software Engineering"`, `"Registered Nurse"`. Used in prompts; only a few fields have tailored weights in code (see below). |
| **Grounding** | Attaching a **real URL** (HN thread, Reddit post) to a tip the AI already wrote — or flagging it `unverified`. Not the same as researching the career from the web upfront. |

---

## What can it do?

Roughly **26 tools** across five areas. Run `npm run smoke` to list them all.

| Area | What you get |
|------|----------------|
| **Interview** | Prep plan, questions, full mock session, hints, adaptive next question, final evaluation |
| **Career** | Guidance, roadmaps, cert analysis/recommendations, log certs, set goal, refresh persona |
| **Study** | Study plans, spaced-repetition drills, concept explanations, resource progress |
| **Proof** | Tips/resources with optional source links — or `unverified` |
| **Analytics** | Patterns and weekly insights from session history |

Plus **5 MCP resources** (e.g. `careercraft://learner/context`) for agents to read without a tool call.

---

## What's hardcoded vs dynamic

Not everything comes from the web or the DB. Here's the split:

### Hardcoded in TypeScript (the "rails")

| File | What's fixed |
|------|----------------|
| `domain/career-paths.ts` | **4 career fields** + a generic default (Software Eng, DevOps/SRE, Data Science/ML, Product Management). Anything else → default weights. |
| `domain/certifications.ts` | **~25 certs** (AWS, Azure, K8s, PMP, …). Cert tools only recommend from this catalog — no hallucinated credentials, but not career-agnostic. |
| `domain/taxonomy.ts` | Skill names and question types used in prompts |
| `domain/roadmap.ts` | Phase structure for roadmaps (Assess → Sharpen → Prove, etc.) |
| `domain/prompts.ts` | Prompt templates (some still say "FAANG hiring manager" — tech-flavored) |

### Dynamic (changes per user / input)

| Source | What moves |
|--------|------------|
| **Supabase** | Skills, certs logged, interview history, scores, goals, applications, persona |
| **JD / saved job** | Role-specific questions and plans when you pass job description text |
| **LLM** | Questions, evaluations, guidance text, study content, roadmap fill-in |
| **`learning_resources` table** | Resources ranked or slotted into plans (only as good as what's in your DB) |
| **Grounding (HN/Reddit)** | Links searched at runtime — mainly for proof, not for building interview content |

**Interview prep for a nurse or mechanical engineer:** pass `field` + **JD** → LLM can do reasonable Q&A. **Cert and roadmap tools** → weak unless you extend the catalog or add web retrieval (not wired into the main flows yet).

---

## External sources: what's actually connected

This is what **really** talks to the outside world today — not what's on a roadmap.

| Source | Used? | Role | API key? |
|--------|-------|------|----------|
| **Supabase** | ✅ Yes (prod) | Auth + all learner data | URL + anon key |
| **AI gateway** (`HORUS_MODE=gateway`) | ✅ Yes | All LLM generation (e.g. Gemini via Lovable gateway) | `MODEL_GATEWAY_KEY` |
| **Hacker News** (`GROUNDING_MODE=hn`) | ✅ Yes | Proof links on tips/resources (`hn.algolia.com`) | No |
| **Reddit** (`GROUNDING_MODE=reddit`) | ✅ Optional | Same proof role (`reddit.com/search.json`) | No |
| **Horus RAG** (`ragSearch`) | ❌ Adapter only | Code exists in `http-client.ts` — **tools never call it** | Horus |
| **Horus graph** (`graphQuery`) | ❌ Adapter only | Same — **not used by tools** | Horus |
| **HTTP grounding bridge** (`GROUNDING_MODE=http`) | ❌ You deploy it | Expected to front Reddit + web search + RAG — **not included in this repo** | Optional |
| **Horus `/infer`** | ❌ Not on Horus yet | Use `gateway` for real generation instead | — |
| **Web search (Exa, Tavily, etc.)** | ❌ Not connected | — | — |

**Default dev:** `HORUS_MODE=mock` + `GROUNDING_MODE=mock` → no real AI, fake proof links.

**Grounding is applied after the AI writes** (tips, coaching, some cert recs). It does **not** yet research "what do nurses get asked" before generating questions. That's the main gap if you want a career-agnostic, web-driven coach.

---

## Quick start (no API keys needed)

```bash
git clone <this-repo>
cd interview-coach-mcp
npm install

# Fully offline — mock AI, fake proof, canned learner, no Supabase
HORUS_MODE=mock GROUNDING_MODE=mock AUTH_MODE=dev npm start
```

Server: **http://localhost:8787**

```bash
npm run smoke          # lists all tools + resources over real MCP

curl -X POST http://localhost:8787/api/proven-tips \
  -H "Content-Type: application/json" \
  -d '{"skill": "System Design", "count": 3}'
```

Mock mode feels complete locally. It is not real intelligence or real persistence.

---

## Run it for real

```bash
cp .env.example .env
```

| Variable | What it does |
|----------|--------------|
| `HORUS_MODE=mock` | Fake AI — dev only |
| `HORUS_MODE=gateway` | Real LLM via OpenAI-compatible API |
| `HORUS_MODE=http` | Horus for RAG/graph; generation needs `/infer` (not shipped) or use gateway |
| `GROUNDING_MODE=hn` | Real Hacker News proof links |
| `GROUNDING_MODE=reddit` | Real Reddit proof links |
| `GROUNDING_MODE=mock` | Fake proof sources |
| `SUPABASE_URL` + `SUPABASE_ANON_KEY` | Real user data, RLS-scoped |
| `AUTH_MODE=dev` | Skip auth, canned learner — **never in production** |

**With CareerCraft's web UI:**

```bash
# interview-coach-mcp/.env
HORUS_MODE=gateway
MODEL_GATEWAY_KEY=<your key>
GROUNDING_MODE=hn
SUPABASE_URL=<your supabase url>
SUPABASE_ANON_KEY=<your anon key>
CORS_ORIGIN=http://localhost:8080

npm start   # :8787

# careercraft-pages — VITE_INTERVIEW_MCP_URL=http://localhost:8787
npm run dev:web   # :8080
```

If the MCP is down, the UI shows "not available" — no silent mock fallback.

**Example — role-specific interview (any field):**

```json
POST /api/interview/questions
{
  "field": "Registered Nurse",
  "seniority": "Mid-Level",
  "jobDescription": "<paste the full job posting here>",
  "count": 6
}
```

The **JD** does more work than `field` alone for non-tech roles.

---

## How auth works

Caller sends a **Supabase JWT** in `Authorization: Bearer …`. Server verifies it and opens an RLS-scoped DB client.

The server **never trusts `userId` in the tool body** — identity always comes from the token.

`AUTH_MODE=dev` skips verification and uses a canned learner; DB writes are blocked or best-effort.

---

## How the AI layer works

This repo **does not import OpenAI / Anthropic / Gemini directly**. All generation goes through `ModelProvider` (`src/adapters/horus/port.ts`):

```ts
await horus.infer({
  task: "interview.evaluate_answer",
  system: "...",
  messages: [{ role: "user", content: user }],
  model: "deep",   // "fast" | "deep" — capability tier, not a model id
  userRef: auth.userId,
});
```

Swap the adapter in `src/adapters/horus/index.ts` to use your own LLM.

`GroundingPort` is separate: model *proposes*, grounding *attaches a link* (or returns null → unverified).

---

## Database

Tied to **CareerCraft's Supabase schema** — not generic Postgres. Tables include `interview_*`, `user_skills`, `user_certifications`, `score_history`, `learning_resources`, `ai_recommendations`, etc.

No migrations live in this repo. Persistence is **best-effort**: failed writes are often swallowed; check `_meta.persisted` in responses when debugging.

---

## Personalization flywheel

When Supabase is real and writes land:

1. Signals in — answers, drills, certs, resource completion, session streaks  
2. `assembleLearnerContext()` — one object for all tools  
3. Tools bias toward weak skills, goals, expiring certs  
4. `refresh_persona` — long-term coach memory in `profiles.ai_persona`  

Without real auth + DB, you only get the canned dev profile or generic LLM output.

---

## Project layout

```
src/
├── server.ts              ← HTTP (MCP + REST)
├── server/build-server.ts ← registers tools per request
├── tools/                 ← interview, career, study, profile, proof, analytics, learning
├── context/               ← assemble.ts (read profile), persist.ts (write skills/patterns)
├── domain/                ← prompts, adaptive, certs, roadmap, taxonomy (much of this is hardcoded)
├── adapters/
│   ├── horus/             ← ModelProvider (mock / gateway / http)
│   ├── grounding/         ← GroundingPort (mock / hn / reddit / http)
│   └── supabase.ts        ← JWT → RLS client
└── schemas.ts             ← Zod inputs for tools
```

**Good contributions:** wire `ragSearch` or web search **before** prompts (career-agnostic research), new grounding connectors, tests for `domain/*`, honest error logging on failed DB writes.

---

## REST routes

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

`POST /mcp` · `GET /health`

---

## Known limitations (honest)

- **Not career-agnostic by default** — cert catalog, career paths, and prompts skew tech. JD + LLM helps interviews; cert/roadmap/proof layers don't generalize automatically.
- **Web research not in the hot path** — HN/Reddit prove tips after the fact; Horus RAG and web search aren't called when building plans or questions.
- **Horus `/infer`** — not available; use `HORUS_MODE=gateway` for real generation.
- **HTTP grounding bridge** — not shipped; compose Reddit + search + RAG yourself if you want it.
- **No automated tests** — `npm run smoke` only lists tools; correctness unverified.
- **Silent DB failures** — many writes in try/catch; response can look fine when nothing saved.
- **Voice interviews, calendar export** — not built.

---

## Scripts

```bash
npm start       # run the server
npm run dev     # hot reload
npm run smoke   # MCP list tools/resources (server must be running)
npm run typecheck
```

Node **18+**.

---

## License

Private / all rights reserved unless otherwise noted. Open an issue for commercial use or a different license.
