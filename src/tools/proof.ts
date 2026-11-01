import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { ResearchSnippet } from "../adapters/research/port.js";
import { config } from "../config.js";
import { assembleLearnerContext } from "../context/assemble.js";
import { resolveFieldProfile } from "../context/field-profile.js";
import { finishedUrls, normaliseUrl, statusFor } from "../context/resources.js";
import { suggestResourcesPrompt } from "../domain/prompts.js";
import * as S from "../schemas.js";
import { groundingFits, ok, proofFromSnippet, researchMeta, researchSafely } from "./_util.js";
import type { ToolDeps } from "./interview.js";

/**
 * proof.* — the grounding layer. Every tip/resource it returns carries a real,
 * vetted source (or is flagged unverified). This is the "backed by Reddit /
 * proven resources" promise, made into tool output the UI renders directly.
 */
export function registerProofTools(server: McpServer, deps: ToolDeps): void {
  const { auth, horus, grounding } = deps;

  // ── get_proven_tips ─────────────────────────────────────────────────────
  server.registerTool(
    "get_proven_tips",
    {
      title: "Get proven, source-backed tips",
      description:
        "Drafts sharp tips for a skill/question, then attaches a REAL vetted source (Reddit thread, proven guide) to each. Tips with no credible source are flagged unverified.",
      inputSchema: S.provenTipsInput,
    },
    async (args) => {
      const ctx = await assembleLearnerContext(auth.db, auth.userId, { field: args.field });
      // The job, not the skill: research on "Behavioural" finds nothing about nursing.
      const field = args.field ?? ctx.goal?.targetField ?? ctx.targetField;
      const focus = args.skill ?? ctx.weakSkills[0]?.name ?? field ?? "interview performance";
      const count = args.count ?? 3;

      // Research the real mistakes/pain points people report, so tips fix what
      // actually trips candidates up in this area rather than generic advice.
      const [research, profile] = await Promise.all([
        researchSafely(deps.research, {
          field: field ?? focus,
          role: ctx.goal?.targetRole,
          intents: ["experience", "question"],
          max: 4,
          // Australian career documents, searched as the learner (one search per job, shared).
          knowledgeIndex: true,
          userToken: auth.jwt,
        }),
        resolveFieldProfile(horus, field, { userRef: auth.userId, userToken: auth.jwt }),
      ]);
      // Each tip says which real post it answers, and that post is its proof.
      const signals = [...research.experiences, ...research.questions].slice(0, 8);

      const system = `You are an elite interview coach. Draft ${count} sharp, specific, NON-generic tips for the focus area, for someone going for this job. If real-world signals are listed, each tip should counter a specific mistake or pain point people actually report there, and "basedOn" is that signal's number; otherwise "basedOn" is null. Each tip is one actionable sentence. Return ONLY JSON: { "tips": [{ "tip": string, "basedOn": number | null }] }.`;
      const user = `JOB: ${field ?? "not given"}\nFOCUS: ${focus}\n${args.question ? `QUESTION: ${args.question}\n` : ""}Avoid platitudes — give tactics an experienced interviewer would respect.${numberedSignals(signals)}`;

      const draft = await horus.infer<{ tips?: unknown[] }>({
        task: "proof.draft_tips",
        expect: ["tips"],
        system,
        messages: [{ role: "user", content: user }],
        model: "fast",
        userRef: auth.userId,
        userToken: auth.jwt,
      });

      const tips = (Array.isArray(draft.data.tips) ? draft.data.tips : [])
        .map((t) =>
          typeof t === "string"
            ? { tip: t, basedOn: null as unknown }
            : { tip: String((t as { tip?: unknown })?.tip ?? "").trim(), basedOn: (t as { basedOn?: unknown })?.basedOn },
        )
        .filter((t) => t.tip)
        .slice(0, count);
      const searchable = groundingFits(grounding, profile);
      const grounded = await Promise.all(
        tips.map(async ({ tip, basedOn }) => {
          const signal = typeof basedOn === "number" ? signals[basedOn - 1] : undefined;
          let proof = signal ? proofFromSnippet(signal) : null;
          if (!proof && searchable) {
            try {
              proof = await grounding.findEvidence({ claim: tip, skill: focus });
            } catch {
              /* grounding best-effort — unverified tips are still returned, labeled */
            }
          }
          return { tip, proof, verified: proof !== null };
        }),
      );

      return ok({
        focus,
        tips: grounded,
        _meta: { model: draft.model, research: researchMeta(research), techSourcesSkipped: !searchable },
      });
    },
  );

  // ── find_proven_resources ───────────────────────────────────────────────
  server.registerTool(
    "find_proven_resources",
    {
      title: "Find proven, source-backed resources",
      description:
        "Returns learning resources for the learner's weak skills / goal, each backed by a real source (community recommendation, primary doc).",
      inputSchema: S.provenResourcesInput,
    },
    async (args) => {
      const ctx = await assembleLearnerContext(auth.db, auth.userId, { field: args.field });
      const field = args.field ?? ctx.goal?.targetField ?? ctx.targetField;
      const skills = args.skills ?? ctx.weakSkills.map((s) => s.name);
      const query = args.goal ?? `interview prep resources for ${skills[0] ?? field ?? "your target role"}`;
      const max = args.maxResults ?? 6;

      // Community-recommended resources for the job (free research), and how
      // technical the job is, which decides whether tech-only links fit.
      const [research, profile] = await Promise.all([
        researchSafely(deps.research, {
          field: field ?? skills[0] ?? args.goal ?? "your field",
          role: ctx.goal?.targetRole,
          intents: ["resource"],
          max,
          // Australian career documents, searched as the learner (one search per job, shared).
          knowledgeIndex: true,
          userToken: auth.jwt,
        }),
        resolveFieldProfile(horus, field, { userRef: auth.userId, userToken: auth.jwt }),
      ]);

      const searchable = groundingFits(grounding, profile);
      let resources: Awaited<ReturnType<typeof grounding.findResources>> = [];
      if (searchable) {
        try {
          resources = await grounding.findResources({ query, skills, max });
        } catch {
          /* best-effort */
        }
      }
      const researched: typeof resources = research.resources.map((s) =>
        s.origin === "knowledge-index"
          ? {
              // A document from the knowledge index: its title is the resource,
              // and the passage that matched says what's in it for this job.
              title: s.sourceLabel,
              provider: "Career knowledge base",
              type: "Guide",
              url: s.sourceUrl,
              why: s.text,
              proof: { kind: "resource", label: s.sourceLabel, stat: s.stat ?? "Knowledge base", url: s.sourceUrl },
            }
          : {
              title: s.text.length > 90 ? `${s.text.slice(0, 89)}…` : s.text,
              provider: s.sourceLabel,
              type: "Discussion",
              url: s.sourceUrl,
              why: "Community-recommended for this field.",
              proof: { kind: "community", label: s.sourceLabel, stat: s.stat ?? "community pick", url: s.sourceUrl },
            },
      );

      // Finished links are never recommended again; saved or started ones say so.
      const done = finishedUrls(ctx.resources);
      const seen = new Set<string>();
      const merged = [...resources, ...researched]
        .filter((r) => {
          const u = normaliseUrl(r.url ?? r.proof.url);
          if (!u || seen.has(u) || done.has(u)) return false;
          seen.add(u);
          return true;
        })
        .slice(0, max)
        .map((r) => {
          const myStatus = statusFor(ctx.resources, r.url ?? r.proof.url);
          return myStatus ? { ...r, myStatus } : r;
        });

      // Nothing real found for this job. Common outside tech: Reddit's API is
      // closed to new apps, and Hacker News only fits software. Rather than an
      // empty page, the coach names what a practitioner would, from its own
      // knowledge, labelled as such (unsourced) and with no invented links:
      // each one's link is a web search for it.
      let suggested: SuggestedResource[] = [];
      if (merged.length === 0) {
        try {
          const { system, user } = suggestResourcesPrompt({
            field: field ?? skills[0] ?? "their field",
            skills,
            goal: args.goal,
            count: Math.min(max, 6),
            ctx,
          });
          const res = await horus.infer<{
            resources?: Array<{ title?: string; type?: string; whyRecommended?: string; howToFind?: string }>;
          }>({
            task: "study.suggest_resources",
            expect: ["resources"],
            system,
            messages: [{ role: "user", content: user }],
            model: "fast",
            userRef: auth.userId,
            userToken: auth.jwt,
          });
          suggested = (Array.isArray(res.data.resources) ? res.data.resources : [])
            .filter((r) => typeof r.title === "string" && r.title.trim())
            .map((r) => {
              const url = searchUrl(r.title!.trim(), field);
              const myStatus = statusFor(ctx.resources, url);
              return {
                title: r.title!.trim(),
                provider: r.howToFind?.trim() || "Suggested by the coach",
                type: r.type ?? "reading",
                url,
                why: r.whyRecommended ?? "",
                proof: null,
                unsourced: true as const,
                ...(myStatus ? { myStatus } : {}),
              };
            })
            .filter((r) => !done.has(normaliseUrl(r.url)!))
            .slice(0, max);
        } catch {
          /* best-effort — an empty list is still an honest answer */
        }
      }

      return ok({
        query,
        skills,
        field: field ?? null,
        resources: merged.length ? merged : suggested,
        _meta: {
          research: researchMeta(research),
          techSourcesSkipped: !searchable,
          // True when nothing real was found and these are the coach's own suggestions.
          unsourced: merged.length === 0 && suggested.length > 0,
        },
      });
    },
  );
}

/** Research signals as a numbered list the tips can point back to. */
function numberedSignals(signals: ResearchSnippet[]): string {
  if (signals.length === 0) return "";
  const lines = signals.map((s, i) => `${i + 1}. ${s.text} [${s.sourceLabel}${s.stat ? `, ${s.stat}` : ""}]`);
  return `\n\nREAL-WORLD SIGNALS — real posts, pages and career guides about this field. Build on these, and never invent a source:\n${lines.join("\n")}\n`;
}

/** A resource the coach suggested from its own knowledge, when no real source was found. */
interface SuggestedResource {
  title: string;
  /** How to find it, in the coach's words. */
  provider: string;
  type: string;
  /** A web search for it: the coach never invents a link. */
  url: string;
  why: string;
  proof: null;
  unsourced: true;
  myStatus?: string;
}

/**
 * A web search for a suggested resource, scoped to the job and the market, so
 * "Australian Medicines Handbook" finds the real thing in one click. Stable for
 * the same title and job, so it can be saved and marked done like any link.
 */
export function searchUrl(title: string, field?: string | null): string {
  const q = [title, field, config.market].filter(Boolean).join(" ");
  return `https://duckduckgo.com/?q=${encodeURIComponent(q)}`;
}
