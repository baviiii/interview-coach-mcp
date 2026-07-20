import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { FieldResearch } from "../adapters/research/index.js";
import { assembleLearnerContext } from "../context/assemble.js";
import { persistSkillSignals } from "../context/persist.js";
import {
  CERT_CATALOG,
  certStatus,
  formatCredentialCandidates,
  matchCertification,
  mergeCredentialCandidates,
  nextCertSuggestions,
} from "../domain/certifications.js";
import {
  careerGuidancePrompt,
  careerRoadmapPrompt,
  certificationAnalysisPrompt,
  certificationRecommendPrompt,
} from "../domain/prompts.js";
import { roadmapSkeleton } from "../domain/roadmap.js";
import * as S from "../schemas.js";
import type { LearnerContext } from "../types.js";
import { err, ok, researchMeta, researchSafely } from "./_util.js";
import type { ToolDeps } from "./interview.js";

/**
 * career.* — certificate-aware career guidance. The curated catalog supplies
 * deterministic facts (what a cert proves, what it costs, when it expires);
 * the model personalizes strategy on top; grounding attaches real sources.
 */

/** Deterministic certification facts the prompts are anchored to. */
export function certFactsBlock(ctx: LearnerContext): string {
  const lines: string[] = [];
  for (const c of ctx.certifications ?? []) {
    const entry = c.catalogId ? CERT_CATALOG.find((e) => e.id === c.catalogId) : null;
    if (entry) {
      lines.push(
        `- HELD: ${entry.name} (${entry.issuer}, ${entry.level}) — status ${c.status}${
          c.expiryDate ? `, expires ${c.expiryDate}` : ""
        }. Vouches for: ${entry.skills.join(", ")}. Market signal: ${entry.marketSignal}`,
      );
    } else {
      lines.push(`- HELD (unrecognized by catalog): ${c.name}${c.issuer ? ` (${c.issuer})` : ""} — status ${c.status}.`);
    }
  }
  if (lines.length === 0) lines.push("- No certifications recorded.");
  return lines.join("\n");
}

/**
 * Build the CANDIDATE CREDENTIALS list for the prompts: curated catalog matches
 * MERGED with credentials researched for the field. The key fix for non-tech
 * fields: when research surfaced real credentials we pass `fallbackToAll: false`
 * so the tech catalog is NOT dumped (a nurse gets NCLEX, not AWS). Catalog stays
 * the fast-path for tech and the offline fallback when research is empty.
 */
function credentialLines(
  ctx: LearnerContext,
  research: FieldResearch,
  opts: { field?: string; seniority?: string; max?: number },
): string {
  const owned = (ctx.certifications ?? []).map((c) => c.catalogId).filter((x): x is string => Boolean(x));
  const hasResearchedCreds = research.credentials.length > 0;
  const catalog = nextCertSuggestions({
    field: opts.field ?? ctx.goal?.targetField ?? ctx.targetField,
    seniority: opts.seniority ?? ctx.goal?.seniority ?? ctx.targetSeniority,
    ownedCatalogIds: owned,
    max: opts.max ?? 6,
    fallbackToAll: !hasResearchedCreds,
  });
  const merged = mergeCredentialCandidates(catalog, research.credentials, opts.max ?? 8);
  return formatCredentialCandidates(merged);
}

export function registerCareerTools(server: McpServer, deps: ToolDeps): void {
  const { auth, horus, grounding } = deps;

  // ── career_guidance ─────────────────────────────────────────────────────
  server.registerTool(
    "career_guidance",
    {
      title: "Personalized career guidance",
      description:
        "Full career read for this learner — position, momentum, strengths to sell, gaps to close, certification moves, 2-3 trajectory options and a narrative — grounded in their real skills, certifications, resume, scores and job pipeline. Optionally answers a specific question.",
      inputSchema: S.careerGuidanceInput,
    },
    async (args) => {
      const ctx = await assembleLearnerContext(auth.db, auth.userId, { field: args.targetField });
      const research = await researchSafely(deps.research, {
        field: args.targetField ?? ctx.goal?.targetField ?? ctx.targetField ?? "their field",
        role: args.targetRole ?? ctx.goal?.targetRole,
        intents: ["credential", "experience", "fact"],
        max: 4,
      });
      const { system, user } = careerGuidancePrompt({
        question: args.question,
        targetRole: args.targetRole,
        horizonMonths: args.horizonMonths,
        ctx,
        certFacts: certFactsBlock(ctx),
        research,
      });
      const res = await horus.infer({
        task: "career.guidance",
        system,
        messages: [{ role: "user", content: user }],
        model: "deep",
        userRef: auth.userId,
      });

      let recommendationId: string | null = null;
      try {
        const { data } = await auth.db
          .from("ai_recommendations")
          .insert({
            user_id: auth.userId,
            recommendation_type: "career_guidance",
            title: `Career guidance: ${args.targetRole ?? ctx.goal?.targetRole ?? ctx.targetField ?? "general"}`,
            description: args.question ?? null,
            ai_reasoning: JSON.stringify(res.data).slice(0, 8000),
            status: "active",
          })
          .select("id")
          .single();
        recommendationId = data?.id ?? null;
      } catch {
        /* best-effort persistence */
      }

      return ok({ guidance: res.data, recommendationId, _meta: { model: res.model, research: researchMeta(research) } });
    },
  );

  // ── analyze_certifications ──────────────────────────────────────────────
  server.registerTool(
    "analyze_certifications",
    {
      title: "Analyze the certification portfolio",
      description:
        "Reads the learner's real certifications, matches them against a curated catalog, flags expiries, and assesses coverage and market value against their target role — with interview talking points per cert.",
      inputSchema: S.analyzeCertificationsInput,
    },
    async (args) => {
      const ctx = await assembleLearnerContext(auth.db, auth.userId, { field: args.targetField });

      // Deterministic facts first — these are true regardless of the model.
      const facts = {
        held: (ctx.certifications ?? []).map((c) => ({
          name: c.name,
          issuer: c.issuer ?? null,
          status: c.status,
          expiryDate: c.expiryDate ?? null,
          recognized: Boolean(c.catalogId),
          skillsVouchedFor: c.skills ?? [],
        })),
        expiringSoon: (ctx.certifications ?? []).filter((c) => c.status === "expiring_soon").map((c) => c.name),
        expired: (ctx.certifications ?? []).filter((c) => c.status === "expired").map((c) => c.name),
        certifiedSkills: [...new Set((ctx.certifications ?? []).flatMap((c) => c.skills ?? []))],
      };

      const research = await researchSafely(deps.research, {
        field: args.targetField ?? ctx.goal?.targetField ?? ctx.targetField ?? "their field",
        role: args.targetRole ?? ctx.goal?.targetRole,
        intents: ["credential", "fact"],
        max: 4,
      });
      const { system, user } = certificationAnalysisPrompt({
        ctx,
        certFacts: certFactsBlock(ctx),
        targetRole: args.targetRole,
        research,
      });
      const res = await horus.infer({
        task: "career.analyze_certifications",
        system,
        messages: [{ role: "user", content: user }],
        model: "fast",
        userRef: auth.userId,
      });

      return ok({ facts, analysis: res.data, _meta: { model: res.model, research: researchMeta(research) } });
    },
  );

  // ── recommend_certifications ────────────────────────────────────────────
  server.registerTool(
    "recommend_certifications",
    {
      title: "Recommend the next certifications",
      description:
        "Ranked next-certification plan from a vetted catalog — prioritized for this learner's goal, gaps, budget and weekly study time, with prep plans and ROI. The top pick is backed by a real community source when one exists.",
      inputSchema: S.recommendCertificationsInput,
    },
    async (args) => {
      const ctx = await assembleLearnerContext(auth.db, auth.userId, { field: args.targetField });
      const count = args.count ?? 3;
      const research = await researchSafely(deps.research, {
        field: args.targetField ?? ctx.goal?.targetField ?? ctx.targetField ?? "their field",
        role: ctx.goal?.targetRole,
        seniority: args.seniority,
        intents: ["credential", "fact"],
        max: 5,
      });
      const candidates = credentialLines(ctx, research, {
        field: args.targetField,
        seniority: args.seniority,
        max: Math.max(count * 2, 6),
      });

      const { system, user } = certificationRecommendPrompt({
        ctx,
        candidates,
        budgetUsd: args.budgetUsd,
        hoursPerWeek: args.hoursPerWeek,
        count,
        research,
      });
      const res = await horus.infer<{ recommendations?: Array<{ name?: string }> }>({
        task: "career.recommend_certifications",
        system,
        messages: [{ role: "user", content: user }],
        model: "deep",
        userRef: auth.userId,
      });

      // Ground the top recommendation in a real source (proof-backed advice).
      const fieldLabel = args.targetField ?? ctx.goal?.targetField ?? ctx.goal?.targetRole ?? "this field";
      let proof = null;
      try {
        const top = res.data.recommendations?.[0]?.name;
        if (top) {
          proof = await grounding.findEvidence({
            claim: `${top} certification worth it for ${fieldLabel}`,
            skill: args.targetField ?? ctx.goal?.targetField,
          });
        }
      } catch {
        /* grounding best-effort */
      }

      let recommendationId: string | null = null;
      try {
        const { data } = await auth.db
          .from("ai_recommendations")
          .insert({
            user_id: auth.userId,
            recommendation_type: "certification",
            title: `Next certifications for ${args.targetField ?? ctx.goal?.targetField ?? "your goal"}`,
            description: null,
            ai_reasoning: JSON.stringify(res.data).slice(0, 8000),
            status: "active",
          })
          .select("id")
          .single();
        recommendationId = data?.id ?? null;
      } catch {
        /* best-effort */
      }

      return ok({
        plan: res.data,
        topPickProof: proof,
        recommendationId,
        _meta: { model: res.model, research: researchMeta(research) },
      });
    },
  );

  // ── log_certification ───────────────────────────────────────────────────
  server.registerTool(
    "log_certification",
    {
      title: "Log a new certification",
      description:
        "Records a certification the learner earned (name, issuer, dates, credential link), matches it against the catalog, credits the skills it vouches for in their skill matrix, and reports what it unlocks.",
      inputSchema: S.logCertificationInput,
    },
    async (args) => {
      const matched = matchCertification(args.name, args.issuer);
      const status = certStatus(args.expiryDate ?? null);

      let certificationId: string | null = null;
      let persisted = false;
      try {
        const { data, error } = await auth.db
          .from("user_certifications")
          .insert({
            user_id: auth.userId,
            name: args.name,
            issuer: args.issuer ?? matched?.issuer ?? null,
            issue_date: args.issueDate ?? null,
            expiry_date: args.expiryDate ?? null,
            credential_id: args.credentialId ?? null,
            credential_url: args.credentialUrl ?? null,
          })
          .select("id")
          .single();
        if (!error) {
          certificationId = data?.id ?? null;
          persisted = true;
        }
      } catch {
        /* best-effort */
      }

      // A passed cert is hard evidence: floor the vouched skills at "certified".
      let skillsCredited: string[] = [];
      if (matched && status !== "expired") {
        skillsCredited = matched.skills;
        try {
          await persistSkillSignals(
            auth.db,
            auth.userId,
            matched.skills.map((name) => ({ name, category: "technical", floor: 65 })),
          );
        } catch {
          /* best-effort */
        }
      }

      return ok({
        certificationId,
        persisted,
        status,
        recognized: matched
          ? {
              catalogId: matched.id,
              name: matched.name,
              issuer: matched.issuer,
              level: matched.level,
              marketSignal: matched.marketSignal,
              validityYears: matched.validityYears,
            }
          : null,
        skillsCredited,
        note: matched
          ? `Recognized as ${matched.name}. Credited: ${matched.skills.join(", ")}.`
          : "Not in the curated catalog — stored as-is. Guidance will treat it conservatively.",
      });
    },
  );

  // ── set_career_goal ─────────────────────────────────────────────────────
  server.registerTool(
    "set_career_goal",
    {
      title: "Set or update the career goal",
      description:
        "Persists the learner's target field, role and seniority so every other tool (questions, plans, guidance, recommendations) conditions on it. The goal IS the personalization anchor.",
      inputSchema: S.setCareerGoalInput,
    },
    async (args) => {
      let preferencesPersisted = false;
      try {
        const { error } = await auth.db.from("user_preferences").upsert(
          {
            user_id: auth.userId,
            preferred_field: args.targetField,
            ...(args.seniority ? { seniority_level: args.seniority } : {}),
            ...(args.jobRoleType ? { job_role_type: args.jobRoleType } : {}),
            ...(args.interviewTypes ? { interview_types: args.interviewTypes } : {}),
            updated_at: new Date().toISOString(),
          },
          { onConflict: "user_id" },
        );
        preferencesPersisted = !error;
      } catch {
        /* best-effort */
      }

      // user_preferences has no target-role column — the role lives as the
      // single active career_goal recommendation (assemble reads it back).
      let rolePersisted = false;
      if (args.targetRole) {
        try {
          await auth.db
            .from("ai_recommendations")
            .update({ status: "expired" })
            .eq("user_id", auth.userId)
            .eq("recommendation_type", "career_goal")
            .eq("status", "active");
          const { error } = await auth.db.from("ai_recommendations").insert({
            user_id: auth.userId,
            recommendation_type: "career_goal",
            title: `Goal: ${args.targetRole}`,
            description: `${args.targetField}${args.seniority ? ` · ${args.seniority}` : ""}`,
            ai_reasoning: "Set by the learner via set_career_goal.",
            status: "active",
          });
          rolePersisted = !error;
        } catch {
          /* best-effort */
        }
      }

      return ok({
        goal: {
          targetField: args.targetField,
          targetRole: args.targetRole ?? null,
          seniority: args.seniority ?? null,
          jobRoleType: args.jobRoleType ?? null,
          interviewTypes: args.interviewTypes ?? null,
        },
        persisted: { preferences: preferencesPersisted, targetRole: args.targetRole ? rolePersisted : null },
      });
    },
  );

  // ── build_career_roadmap ────────────────────────────────────────────────
  server.registerTool(
    "build_career_roadmap",
    {
      title: "Build a career roadmap",
      description:
        "Week-addressed, phase-structured roadmap to a target role: skill targets from real proficiencies, certification track from the vetted catalog, mock-interview cadence, weekly rhythm and checkable phase exits. Persisted so it can be re-explained later.",
      inputSchema: S.buildRoadmapInput,
    },
    async (args) => {
      if (!args.targetRole?.trim()) return err("targetRole is required.");
      const ctx = await assembleLearnerContext(auth.db, auth.userId, { field: args.targetField });
      const research = await researchSafely(deps.research, {
        field: args.targetField ?? ctx.goal?.targetField ?? ctx.targetField ?? args.targetRole,
        role: args.targetRole,
        intents: ["credential", "experience", "fact"],
        max: 4,
      });

      const skeleton = roadmapSkeleton(args.horizonWeeks ?? 12, args.hoursPerWeek ?? 6);
      const skeletonText = [
        `Horizon: ${skeleton.horizonWeeks} weeks × ${skeleton.hoursPerWeek} h/week (${skeleton.totalHours}h total, ${skeleton.intensity} intensity)`,
        `Cadence: ${skeleton.mocksPerWeek} mock interview(s)/week, ${skeleton.drillsPerWeek} drills/week`,
        ...skeleton.phases.map((p) => `Phase ${p.index} "${p.name}" (weeks ${p.fromWeek}-${p.toWeek}): ${p.intent}`),
      ].join("\n");

      const { system, user } = careerRoadmapPrompt({
        targetRole: args.targetRole,
        ctx,
        skeleton: skeletonText,
        certShortlist: credentialLines(ctx, research, { field: args.targetField, max: 3 }),
        certFacts: certFactsBlock(ctx),
        research,
      });
      const res = await horus.infer({
        task: "career.roadmap",
        system,
        messages: [{ role: "user", content: user }],
        model: "deep",
        userRef: auth.userId,
      });

      let recommendationId: string | null = null;
      try {
        const { data } = await auth.db
          .from("ai_recommendations")
          .insert({
            user_id: auth.userId,
            recommendation_type: "roadmap",
            title: `Roadmap: ${args.targetRole} (${skeleton.horizonWeeks}w)`,
            description: `${skeleton.hoursPerWeek} h/week · ${skeleton.intensity}`,
            ai_reasoning: JSON.stringify(res.data).slice(0, 8000),
            status: "active",
          })
          .select("id")
          .single();
        recommendationId = data?.id ?? null;
      } catch {
        /* best-effort */
      }

      return ok({
        roadmap: res.data,
        skeleton,
        recommendationId,
        _meta: { model: res.model, research: researchMeta(research) },
      });
    },
  );
}
