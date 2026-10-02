# interview-coach-mcp

An MCP server that acts as the **brain** behind a career coach — mock interviews, study plans, cert advice, roadmaps, and tips that know who the learner is (when Supabase is wired up).

Built for [CareerCraft](https://github.com/) (the web app), but you can run it on its own, plug it into any MCP client (Cursor, Claude Desktop, etc.), or wire it into your own product.

**Scope (honest):** it now works for **any field** — nurse, electrician, teacher, accountant, paralegal, chef — because before generating it **researches the field from free, real sources** (Reddit, Hacker News, Wikipedia) and feeds those *cited* findings into the prompt. So a nurse gets NCLEX/licensure (with source links), not AWS. Every field — tech included — goes through the same path: a runtime *field profile* decides its question formats, key skills and expected credentials; nothing is special-cased in code. The one caveat: Reddit's anonymous endpoint is often rate-limited (403) from datacenter IPs — add **free** Reddit app credentials to make it reliable (Wikipedia + HN need nothing). See [Live research](#live-research-grounded-before-generating), [What's hardcoded vs dynamic](#whats-hardcoded-vs-dynamic) and [External sources](#external-sources-whats-actually-connected).

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
        │  research the field FIRST (any field, free + cited)
        ▼
  ResearchPort   ──▶  Reddit · Hacker News · Wikipedia · your RAG
        │
        │  generate / evaluate / plan / drill … (prompt now carries real signals)
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
| **Field** | Broad career label you pass in, e.g. `"Software Engineering"`, `"Registered Nurse"`. Every field gets a runtime-generated profile (key skills, question formats, expected credentials) — no field is special-cased in code (see below). |
| **Research** | Pulling **real, cited material about a field BEFORE generating** — the questions people report, where they struggled, the licenses/certs the field expects, the courses the community recommends — from free sources, and feeding it into the prompt. This is what makes the coach career-agnostic. |
| **Grounding** | Attaching a **real URL** (HN thread, Reddit post) to a tip the AI already wrote — or flagging it `unverified`. The *after-the-fact* complement to Research's *before-the-fact* sourcing. |

---

## What can it do?

Roughly **27 tools** across six areas. Run `npm run smoke` to list them all.

| Area | What you get |
|------|----------------|
| **Interview** | Prep plan, questions, full **structured** mock session, hints, adaptive next question, final evaluation |
| **Career** | Guidance, roadmaps, cert analysis/recommendations, log certs, set goal, refresh persona |
| **Study** | Study plans, spaced-repetition drills, concept explanations, resource progress |
| **Learning** | One-call learning pathway, ranked resources, recommendation explanations |
| **Proof** | Tips/resources with optional source links — or `unverified` |
| **Analytics** | Patterns and weekly insights from session history |

Plus **5 MCP resources** (e.g. `careercraft://learner/context`) for agents to read without a tool call.

---

## The mock interview is a loop, not a question list

A "full interview" is built from a **deterministic blueprint** (`domain/interview-loop.ts`) before the
model is ever called — the same division of labour as the roadmap skeleton. We decide the shape:

```
warmup → domain → behavioral → behavioral → situational → closing
```

Each slot fixes its stage, question type, difficulty (ramped to seniority) and which of the learner's
real skills it probes; the model only writes the content. That is what makes the guarantees hold:

- **Behavioral questions are structural.** A loop of 4+ questions always carries at least two, whatever
  the field's technical bias. Telling a model "~40% behavioral" in prose did not survive contact with reality.
- **Questions are personal.** Generation sees the learner's resume, persona, stated goal, target job and
  JD, application pipeline and full skill matrix — not just a list of weak skills — and each question comes
  back with a `whyThisQuestion` you can show the candidate, plus the `followUps` the interviewer would push with.
- **Sessions don't repeat.** `recentQuestionThemes` (their last ~3 sessions) is fed in as a do-not-repeat list,
  and a cliché ban list rules out "tell me about yourself", "greatest weakness" and stock puzzles.
- **Evaluation matches the question.** Rubric weights move with question type — behavioral answers are scored
  on STAR completeness and ownership (with a `starBreakdown`), technical ones on correctness and trade-offs.
- **The debrief scores stages separately** and emits `nextSessionFocus`, which the learning pathway reads back.

---

## Learning pathway (one call for the whole learning side)

`get_learning_pathway` / `POST /api/learning/pathway` returns what to work on, a week-by-week plan, ranked
resources, the drill that's due and what the next mock should target — persisted as one resumable
recommendation.

It is built to work on an **empty database**. Every piece degrades instead of failing:

| Situation | Old behaviour | Now |
|-----------|---------------|-----|
| `learning_resources` table empty | `resources: []` — page looks broken | Ranks community-researched resources instead; if those are empty too, returns model-suggested learning *moves* flagged `unsourced` |
| No tracked skills (new user) | Hard error, "No skills to plan around" | Targets derived from last debrief → skill matrix → career goal → field → research, with `targetSource` saying which |
| No `targetRole` on a roadmap | Hard error | Falls back to the learner's stated goal or target job |

Every learning response carries `_meta.degraded = { degraded, reasons[] }` so "nothing showed up" is always
explainable from the response itself.

---

## Live research (grounded before generating)

The thing that makes this work for **any** field. Before a tool generates, it asks the `ResearchPort` for real, **cited** material about the field and feeds it into the prompt as `REAL-WORLD SIGNALS`. The model is told to mirror those themes, only name credentials/resources that appear there, and never invent a source.

| Bucket | Example for "Registered Nurse" | Source |
|--------|--------------------------------|--------|
| **questions** | "Tell me about a time you advocated for a patient against a physician's order." | Reddit, HN |
| **experiences** ("users who had issues") | "I bombed the situational judgment portion because I rushed." | Reddit |
| **credentials** | NCLEX-RN, BLS, state licensure | Wikipedia, Reddit |
| **resources** | community-recommended review courses/books | Reddit, HN |
| **facts** | what the role is + entry requirements | Wikipedia |

**All free, no API key.** Modes (`RESEARCH_MODE`): `auto` (default — Reddit + HN + Wikipedia + your RAG), `reddit`, `mock` (offline), `off` (degrade to pre-research behavior).

Tools wired to research: `generate_contextual_questions`, `start_interview_session`, `next_question`, `finish_interview`, `build_interview_plan`, `get_proven_tips`, `find_proven_resources`, `rank_learning_resources`, `get_learning_pathway`, `recommend_certifications`, `analyze_certifications`, `career_guidance`, `build_career_roadmap`, `build_study_plan`. Each surfaces its real sources in `_meta.research`.

**The Reddit caveat (important):** Reddit's anonymous `search.json` is now commonly **403-blocked from datacenter IPs** (any User-Agent). Wikipedia + Hacker News work everywhere with zero config. To make Reddit reliable, add **free** app credentials (no cost — just register at `reddit.com/prefs/apps`):

```bash
REDDIT_CLIENT_ID=...      # free "script"/"web app"
REDDIT_CLIENT_SECRET=...
```

With those set, research uses Reddit's app-only OAuth endpoint instead. Everything stays $0.

It's **best-effort**: a blocked/slow source is dropped, `_meta.research.partial` flags it, and the tool still produces output from whatever real signals it did get (or its pre-research behavior if none).

---

## What's hardcoded vs dynamic

Not everything comes from the web or the DB. Here's the split:

### Hardcoded in TypeScript (the "rails")

| File | What's fixed |
|------|----------------|
| `domain/field-profile.ts` | **No occupation is named in code.** Only the field-independent rules: the question formats the rubric can score (technical, practical, case study, coding, system design) and how seniority shifts weight from craft depth to leadership. What each field actually needs comes from its *field profile* (see below). |
| `domain/certifications.ts` | **~25 certs** (AWS, Azure, K8s, PMP, …) used as a **lookup table only** — it fills in cost, prep hours and level when a suggested credential matches, but never suggests anything itself, so its tech bias can't reach other fields. |
| `domain/roadmap.ts` | Phase structure for roadmaps (Assess → Sharpen → Prove, etc.) |
| `domain/interview-loop.ts` | Mock-interview stage structure (warmup → domain → behavioral → situational → closing) and the behavioural floor |
| `domain/targets.ts` | Cold-start fallback chain for skill targets (debrief → matrix → field profile → research → universal fundamentals) |
| `domain/prompts.ts` | Prompt templates, the cliché ban list, and the per-question-type evaluation rubrics |

### Field profiles (per field, generated at runtime)

The first time a field is seen, one fast model call describes how that field hires: its key skills, how
technical its interviews are, which question formats it uses, and the licences/certifications it expects.
`parseFieldProfile` validates and clamps the answer, and `context/field-profile.ts` caches it for 24 hours
per server instance. A nurse gets practical and case-study questions plus RN/BLS/ACLS; a backend engineer
gets coding and system design plus AWS/CKA (with catalog cost data). If the call fails, the field gets a
**neutral** profile (balanced weights, formats any job can answer, no assumed skills), never software defaults.
Credentials from a profile are labelled `model knowledge` so the advice tells the learner to confirm them with the issuing body.

### Dynamic (changes per user / input)

| Source | What moves |
|--------|------------|
| **Supabase** | Skills, certs logged, interview history, scores, goals, applications, persona |
| **JD / saved job** | Role-specific questions and plans when you pass job description text |
| **LLM** | Questions, evaluations, guidance text, study content, roadmap fill-in |
| **`learning_resources` table** | Resources ranked or slotted into plans (only as good as what's in your DB) |
| **Research (Reddit/HN/Wikipedia/RAG)** | Real, cited field material fetched at runtime **before** generation — questions, pain points, credentials, resources, facts. This is the career-agnostic engine. |
| **Grounding (HN/Reddit)** | Links searched at runtime — proof attached to tips *after* the AI writes them |

**Interview prep for a nurse or mechanical engineer:** just pass `field` (a JD still helps). Questions, tips, **cert/roadmap, and resource tools now research the field first** (free) and ground on what they find — credentials come from Wikipedia/Reddit with source links plus the field profile, never from the tech catalog. Research quality scales with what the free sources return for that field (and with Reddit creds set, per [Live research](#live-research-grounded-before-generating)).

---

## External sources: what's actually connected

This is what **really** talks to the outside world today — not what's on a roadmap.

| Source | Used? | Role | API key? |
|--------|-------|------|----------|
| **Supabase** | ✅ Yes (prod) | Auth + all learner data | URL + anon key |
| **AI gateway** (`HORUS_MODE=gateway`) | ✅ Yes | All LLM generation (e.g. Gemini via Lovable gateway) | `MODEL_GATEWAY_KEY` |
| **Hacker News** (`hn.algolia.com`) | ✅ Yes | **Research** (questions/resources, any field) + proof links | No |
| **Wikipedia** (Action API) | ✅ Yes | **Research** — role facts + the credentials/licenses a field expects | No |
| **Reddit** (`reddit.com`) | ✅ Yes | **Research** ("users who had issues") + proof. Anonymous often 403s → set free `REDDIT_CLIENT_ID/SECRET` for app-only OAuth | No (free creds recommended) |
| **Horus RAG** (`ragSearch`) | ✅ When provided | **Now called by research** (`HorusRagResearchSource`) — your curated corpus, if the provider implements `ragSearch` | Horus |
| **Horus graph** (`graphQuery`) | ❌ Adapter only | Still not used by tools | Horus |
| **HTTP grounding bridge** (`GROUNDING_MODE=http`) | ❌ You deploy it | Expected to front Reddit + web search + RAG — **not included in this repo** | Optional |
| **Horus `/infer`** | ❌ Not on Horus yet | Use `gateway` for real generation instead | — |
| **Web search (Exa, Tavily, etc.)** | ❌ Not connected | — | — |

**Default dev:** `HORUS_MODE=mock` + `GROUNDING_MODE=mock` + `RESEARCH_MODE=mock` → no real AI, fake proof, canned research.

**Two layers now:** **Research runs *before* the AI writes** ("what do nurses actually get asked / struggle with / need certified") and feeds real cited material into the prompt — this is the career-agnostic engine. **Grounding still runs *after*** (a proof link on a finished tip). The old "main gap" (no upfront research) is closed for the free sources above; paid web search (Exa/Tavily) behind the same `ResearchPort` seam is the next step if you want broader coverage.

---

## Quick start (no API keys needed)

```bash
git clone <this-repo>
cd interview-coach-mcp
npm install

# Fully offline — mock AI, fake proof, canned research, canned learner, no Supabase
HORUS_MODE=mock GROUNDING_MODE=mock RESEARCH_MODE=mock AUTH_MODE=dev npm start
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
| `MARKET=Australia` | The country learners are job-hunting in (default `Australia`). Every model call is told to use its regulators, licensing, qualification framework, spelling and currency, and to flag state/territory differences; licence, course and role-fact research is scoped to it first |
| `RESEARCH_MODE=auto` | **Live field research** (free): Reddit + HN + Wikipedia + your RAG — the default |
| `RESEARCH_MODE=reddit` / `mock` / `off` | Reddit only / offline canned / disabled |
| `REDDIT_CLIENT_ID` + `REDDIT_CLIENT_SECRET` | Free Reddit app creds → reliable Reddit research (anonymous often 403s) |
| `SUPABASE_URL` + `SUPABASE_ANON_KEY` | Real user data, RLS-scoped |
| `AUTH_MODE=dev` | Skip auth, canned learner — **never in production** (the server refuses to boot with it when `NODE_ENV=production`) |
| `RATE_LIMIT_WINDOW_MS` / `RATE_LIMIT_MAX` | Per-user (hashed token, else IP) rate limit on `/mcp` + `/api` — default 60 req/min. A spend cap: every request can trigger research + a paid LLM call |
| `LLM_TIMEOUT_MS` | Hard cap per model call (default 60s) — a hung gateway no longer hangs the request |

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
├── domain/                ← prompts, field profiles, adaptive, certs, roadmap (field-independent rules)
├── adapters/
│   ├── horus/             ← ModelProvider (mock / gateway / http)
│   ├── grounding/         ← GroundingPort (mock / hn / reddit / http) — proof AFTER
│   ├── research/          ← ResearchPort (reddit / hn / wikipedia / rag) — research BEFORE
│   └── supabase.ts        ← JWT → RLS client
└── schemas.ts             ← Zod inputs for tools
```

**Good contributions:** a paid web-search `ResearchSource` (Exa/Tavily) behind the existing `ResearchPort` seam, more research sources (Glassdoor-style, official licensing boards), better credential-name extraction, more tests for `domain/*`, honest error logging on failed DB writes.

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
| `POST /api/learning/pathway` | `get_learning_pathway` |
| `POST /api/proven-tips` | `get_proven_tips` |
| `POST /api/resources` | `find_proven_resources` |
| `POST /api/resources/rank` | `rank_learning_resources` |
| `POST /api/recommendations/explain` | `explain_recommendation` |
| `POST /api/analytics/patterns` | `analyze_patterns` |
| `POST /api/analytics/weekly` | `weekly_insight` |

`POST /mcp` · `GET /health`

---

## Known limitations (honest)

- **Career-agnostic now, but quality scales with the sources** — research grounds any field, but output is only as rich as what Reddit/HN/Wikipedia return for it. Thin niches get thinner grounding.
- **Reddit anonymous is often 403'd** — set free `REDDIT_CLIENT_ID/SECRET` for reliable Reddit research; otherwise it leans on Wikipedia + HN. See [Live research](#live-research-grounded-before-generating).
- **No paid web search yet** — Exa/Tavily would broaden coverage (courses, salary, niche credentials) behind the same `ResearchPort` seam, but aren't wired (kept $0 by choice).
- **Horus `/infer`** — not available; use `HORUS_MODE=gateway` for real generation.
- **HTTP grounding bridge** — not shipped; compose Reddit + search + RAG yourself if you want it.
- **Tests cover mock mode, not a live LLM** — CI runs typecheck + unit tests + an offline e2e golden path (start → answer → finish over real HTTP). Tool I/O against a *live* LLM is still unverified by CI.
- **DB failures are best-effort but no longer silent** — failed writes log a `[persist]` warning and `_meta.persisted` reflects the truth; the response itself still succeeds by design.
- **Rate limit is single-instance** — the in-memory limiter guards one process; put a shared limiter in front if you scale out.
- **Voice interviews, calendar export** — not built.

---

## Deploy

```bash
docker build -t interview-coach-mcp .
docker run -p 8787:8787 --env-file .env -e NODE_ENV=production interview-coach-mcp
```

Or point any Node host (Railway, Render, Fly) at `npm start` — no build step needed.
In production set `NODE_ENV=production` (enforces the auth guard), a real
`CORS_ORIGIN`, and the free `REDDIT_CLIENT_ID/SECRET` (datacenter IPs can't use
anonymous Reddit — without creds your best research source silently drops out).

CI (`.github/workflows/ci.yml`) runs typecheck + unit tests + the offline e2e
golden path on every push.

**Production deploys are automatic.** Every push to `main` that passes CI builds
the image, pushes it to `ghcr.io/baviiii/interview-coach-mcp:<commit>` (public —
it holds only what this repo already shows), and rolls the Azure Container App
onto it, failing the run unless the new revision comes up healthy. Settings and
secrets are not in the image: they live on the container app and survive every
deploy, so change them there (`az containerapp update --set-env-vars …` /
`az containerapp secret set …`), never in the workflow. GitHub logs in to Azure
with OIDC as the `id-gh-interview-coach-mcp-deploy` managed identity, which only
accepts tokens from this repo's `main` — there are no stored credentials.

---

## Scripts

```bash
npm start       # run the server
npm run dev     # hot reload
npm run smoke   # MCP list tools/resources (server must be running)
npm test        # pure unit checks for the research + cert-merge logic (no network)
npm run e2e     # boots the server offline (mock everything) and walks the golden path
npm run typecheck
```

Node **18+**.

---

## License

Private / all rights reserved unless otherwise noted. Open an issue for commercial use or a different license.
