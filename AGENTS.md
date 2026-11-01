# AGENTS.md — interview-coach-mcp

Instructions for any AI coding agent (Claude Code, Codex, Cursor…) working in this
repo. Read this before changing anything.

This is the interview coach: an Express server exposing ~29 tools over MCP
(`POST /mcp`) and REST (`POST /api/...`). Faircopy (careercraft-pages) calls the
REST routes; AI calls go through CareerCraft's Supabase `infer` function to Horus.
Production runs on AWS Lambda.

## Before every push — no exceptions

**Pushing to `main` deploys to production** (CI builds the image and rolls the
Lambda). A push to any other branch still runs CI. So every push, to any branch:

1. **Run the checks, all green:**
   ```bash
   npm run typecheck
   npm test
   npm run e2e        # offline; spawns its own server on :8790
   npm run build
   npm run schema-check   # live DB columns this code uses (needs .env)
   ```
   Changed a prompt, rubric or scoring code? Also run `npm run score-check`
   (real model, a few cents). If you can, try the changed tool against the real
   model with `AUTH_MODE=dev npm start` — offline tests use a mock model and
   can't catch what a real one does with a prompt.
2. **Code review the diff** for correctness bugs (in Claude Code: `/code-review`).
3. **Security review the diff** (in Claude Code: `/security-review`): secrets,
   auth (identity always comes from the JWT, never the request body), what each
   endpoint exposes, injection, CORS.
4. **Show the owner the diff and wait for an explicit yes.** Plain-language
   explanation of each change, plus the check and review results. Approval is
   per push: an earlier "go ahead" doesn't cover the next one, and approving a
   summary isn't the same as seeing the code.

Never `--no-verify`, never force-push, never commit secrets (`.env` is gitignored —
keep it that way). Don't deploy by hand: merging to `main` is the deploy.

## Other agents may be working here

More than one agent session can share this folder. Before anything else:
`git status` and `git log --oneline -3` — if the branch or files aren't what you
expect, someone else is working. Don't switch their branch, don't revert or commit
changes you didn't make, and never `git add -A` blindly: add your own files by
name. To work on another branch without disturbing them, use a temporary
`git worktree` outside the repo.

## Things that have broken before

- **Prompts and answer shapes.** Horus forces every answer into JSON. Without
  a schema that's only "a JSON object", and a model can write the first section
  and stop — interviews started with no questions that way (2026-11-01). The
  interview calls send exact shapes (`src/domain/answer-shapes.ts`, returned by
  each prompt function): change a prompt's `Return ONLY JSON` block and its
  shape together; `npm test` checks they match. In prompts without a shape, put
  what the tool needs first.
- **Every answer is checked** (`withAnswerCheck`, `src/adapters/horus/answer-check.ts`)
  and an unusable one asked for once more. Name the fields a new tool can't work
  without in `expect`. Every call also carries the "career changes are normal"
  note (`withMarket` in `src/adapters/horus/index.ts`).
- **Model tiers come from the plan.** The coach asks for `deep` (Claude Sonnet)
  for interview work; CareerCraft's `plan_limits` decides what each plan gets.
  Free and Premium get the same model and differ in how many calls.
- **Database changes come from CareerCraft.** This repo has no migrations. A
  column you use must be live first (careercraft-pages migration → its `main`),
  and listed in `src/schema-used.ts`; CI's schema check enforces it.
- **Node 22 or later.** supabase-js crashes on Node 20 and every signed-in
  request 500s while `/health` stays green.
- **Lambda copies are short-lived.** In-memory caches and the rate limiter live
  per copy; anything that must last goes in the database.
- **Supabase Edge Functions refuse bursts** (503 `BOOT_ERROR`); `HttpHorusClient`
  retries only that. Don't add parallel model calls inside one tool without need.
- **Never tell the owner a source or limit exists without checking it** — e.g.
  Reddit's API is no longer self-serve.

## Where things are

`src/tools/` (one file per area) · `src/domain/` (prompts, scoring, blueprints —
the rules) · `src/context/` (reads/writes the learner's data) ·
`src/adapters/` (model, research, proof sources) · `scripts/` (tests, checks).
README.md has the full picture.
