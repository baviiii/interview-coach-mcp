import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { FieldResearch } from "../adapters/research/index.js";
import { assembleLearnerContext } from "../context/assemble.js";
import { resolveFieldProfile } from "../context/field-profile.js";
import { persistSkillSignals } from "../context/persist.js";
import {
  buildCredentialCandidates,
  CERT_CATALOG,
  certStatus,
  formatCredentialCandidates,
  matchCertification,
} from "../domain/certifications.js";
import { describeInterviewStyle, type FieldProfile } from "../domain/field-profile.js";
import { toStoredLevel, withTargetTitleFirst } from "../domain/goal.js";
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
 * Build the CANDIDATE CREDENTIALS list for the prompts: credentials researched
 * for the field plus the ones its profile says it expects, enriched with catalog
 * facts where the catalog recognises them. The same path runs for every field,
 * so a nurse gets NCLEX and a cloud engineer gets AWS, and neither depends on
 * research happening to succeed.
 */
function credentialLines(
  ctx: LearnerContext,
  research: FieldResearch,
  profile: FieldProfile,
  opts: { seniority?: string; max?: number },
): string {
  const candidates = buildCredentialCandidates({
    researched: research.credentials,
    expected: profile.credentials,
    held: ctx.certifications ?? [],
    seniority: opts.seniority ?? ctx.goal?.seniority ?? ctx.targetSeniority,
    max: opts.max ?? 8,
  });
  return formatCredentialCandidates(candidates);
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

        userToken: auth.jwt,
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

        userToken: auth.jwt,
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
        "Ranked next-certification/licence plan for any field — prioritized for this learner's goal, gaps, budget and weekly study time, with prep plans and ROI. The top pick is backed by a real community source when one exists.",
      inputSchema: S.recommendCertificationsInput,
    },
    async (args) => {
      const ctx = await assembleLearnerContext(auth.db, auth.userId, { field: args.targetField });
      const count = args.count ?? 3;
      const field = args.targetField ?? ctx.goal?.targetField ?? ctx.targetField;
      const [research, profile] = await Promise.all([
        researchSafely(deps.research, {
          field: field ?? "their field",
          role: ctx.goal?.targetRole,
          seniority: args.seniority,
          intents: ["credential", "fact"],
          max: 5,
        }),
        resolveFieldProfile(horus, field, { userRef: auth.userId, userToken: auth.jwt }),
      ]);
      const candidates = credentialLines(ctx, research, profile, {
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

        userToken: auth.jwt,
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
        "Persists the learner's target field, role and seniority so every other tool (questions, plans, guidance, recommendations) conditions on it. The goal IS the personalization anchor. Pass targetRole (a job title, e.g. 'ICU nurse'): it becomes the learner's first target job title, which the web app and every tool read first; a field alone is kept only as a fallback.",
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

      // The profile is the source of truth the web app and assemble both read,
      // so the goal goes there too: the role first in the target titles (only a
      // job title — a field label like "Software Engineering" isn't one), and
      // the seniority as the stored career level.
      let profilePersisted = false;
      const level = toStoredLevel(args.seniority);
      if (args.targetRole || level) {
        try {
          const updates: Record<string, unknown> = {};
          if (level) updates.career_level = level;
          if (args.targetRole) {
            const { data, error } = await auth.db
              .from("profiles")
              .select("target_job_titles")
              .eq("id", auth.userId)
              .maybeSingle();
            // Unread titles must never be overwritten: that would erase the learner's list.
            if (error) throw error;
            updates.target_job_titles = withTargetTitleFirst(data?.target_job_titles, args.targetRole);
          }
          const { error } = await auth.db.from("profiles").update(updates).eq("id", auth.userId);
          profilePersisted = !error;
        } catch {
          /* best-effort — the older records above still hold the goal */
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
        persisted: {
          preferences: preferencesPersisted,
          targetRole: args.targetRole ? rolePersisted : null,
          profile: profilePersisted,
        },
      });
    },
  );

  // ── describe_field ──────────────────────────────────────────────────────
  server.registerTool(
    "describe_field",
    {
      title: "Describe a job",
      description:
        "Turns what a learner typed ('sparky', 'nurse icu') into the standard job title, what its interviews focus on, the licences it expects in this market and what each career stage is called — for confirming a role before saving it. known=false means it isn't a recognisable job, and nothing about it is invented. Errors when the job couldn't be checked, so a failed lookup is never mistaken for 'not a job'.",
      inputSchema: S.describeFieldInput,
    },
    async (args) => {
      const profile = await resolveFieldProfile(horus, args.field, { userRef: auth.userId, userToken: auth.jwt });
      // A neutral profile is either an answer ("not a job") or a failed lookup.
      // Only the first may come back as known=false; the second must fail, so the
      // caller retries rather than telling the learner their job isn't real.
      if (profile.source === "neutral" && !profile.notOccupation) {
        return err("Couldn't check that job right now. Try again in a moment.");
      }
      const known = profile.source === "model";
      return ok({
        input: args.field,
        known,
        canonicalTitle: profile.canonicalTitle,
        interviewStyle: known ? describeInterviewStyle(profile) : null,
        keySkills: profile.keySkills,
        credentials: [...profile.credentials]
          .sort((a, b) => Number(b.required) - Number(a.required))
          .map((c) => ({ ...c, source: "model knowledge — confirm with the issuing body" })),
        levels: profile.levels,
      });
    },
  );

  // ── build_career_roadmap ────────────────────────────────────────────────
  server.registerTool(
    "build_career_roadmap",
    {
      title: "Build a career roadmap",
      description:
        "Week-addressed, phase-structured roadmap to a target role in any field: skill targets from real proficiencies, the licences/certifications that field expects, mock-interview cadence, weekly rhythm and checkable phase exits. Persisted so it can be re-explained later.",
      inputSchema: S.buildRoadmapInput,
    },
    async (args) => {
      const ctx = await assembleLearnerContext(auth.db, auth.userId, { field: args.targetField });
      // A learner who already told us their goal shouldn't have to repeat it —
      // requiring targetRole here made the roadmap look broken from the UI.
      const targetRole = args.targetRole?.trim() || ctx.goal?.targetRole || ctx.job?.title;
      if (!targetRole) {
        return err(
          "No target role to build a roadmap toward — pass `targetRole` or set a career goal first (set_career_goal).",
        );
      }
      const field = args.targetField ?? ctx.goal?.targetField ?? ctx.targetField ?? targetRole;
      const [research, profile] = await Promise.all([
        researchSafely(deps.research, {
          field,
          role: targetRole,
          intents: ["credential", "experience", "fact"],
          max: 4,
        }),
        resolveFieldProfile(horus, field, { userRef: auth.userId, userToken: auth.jwt }),
      ]);

      const skeleton = roadmapSkeleton(args.horizonWeeks ?? 12, args.hoursPerWeek ?? 6);
      const skeletonText = [
        `Horizon: ${skeleton.horizonWeeks} weeks × ${skeleton.hoursPerWeek} h/week (${skeleton.totalHours}h total, ${skeleton.intensity} intensity)`,
        `Cadence: ${skeleton.mocksPerWeek} mock interview(s)/week, ${skeleton.drillsPerWeek} drills/week`,
        ...skeleton.phases.map((p) => `Phase ${p.index} "${p.name}" (weeks ${p.fromWeek}-${p.toWeek}): ${p.intent}`),
      ].join("\n");

      const { system, user } = careerRoadmapPrompt({
        targetRole,
        ctx,
        skeleton: skeletonText,
        certShortlist: credentialLines(ctx, research, profile, { max: 3 }),
        certFacts: certFactsBlock(ctx),
        research,
      });
      const res = await horus.infer({
        task: "career.roadmap",
        system,
        messages: [{ role: "user", content: user }],
        model: "deep",
        userRef: auth.userId,

        userToken: auth.jwt,
      });

      let recommendationId: string | null = null;
      try {
        const { data } = await auth.db
          .from("ai_recommendations")
          .insert({
            user_id: auth.userId,
            recommendation_type: "roadmap",
            title: `Roadmap: ${targetRole} (${skeleton.horizonWeeks}w)`,
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
