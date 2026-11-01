/**
 * The exact JSON each interview call must return, as JSON Schema.
 *
 * Without a schema the model is only made to return "a JSON object", and it
 * can stop after the first section it writes — that is how interviews started
 * with no questions on 2026-11-01. With one, Horus makes the model fill these
 * fields, in this order. Each shape mirrors the "Return ONLY JSON" block of
 * its prompt in prompts.ts, and the prompt function returns it alongside the
 * text, built from the same inputs, so the two can't drift apart.
 *
 * Types are kept loose (strings, not enums) where the prompt already pins the
 * value: the schema guarantees the fields are there; the prompt and the
 * server's own checks decide what goes in them.
 */

export type JsonSchema = Record<string, unknown>;

const str = (description?: string): JsonSchema => ({ type: "string", ...(description && { description }) });
const num = (): JsonSchema => ({ type: "number" });
const bool = (): JsonSchema => ({ type: "boolean" });
const list = (items: JsonSchema): JsonSchema => ({ type: "array", items });
/** Every property listed is required unless named in `optional`. */
function obj(properties: Record<string, JsonSchema>, optional: string[] = []): JsonSchema {
  return { type: "object", properties, required: Object.keys(properties).filter((k) => !optional.includes(k)) };
}
const nullable = (schema: JsonSchema): JsonSchema => ({ ...schema, type: [schema.type, "null"] });

const question = (extra: Record<string, JsonSchema> = {}): JsonSchema =>
  obj(
    {
      id: num(),
      question: str(),
      stage: str(),
      type: str(),
      difficulty: str(),
      category: str(),
      skillsTested: list(str()),
      expectedTopics: list(str()),
      ...extra,
      whyThisQuestion: str(),
      followUps: list(str()),
    },
    ["category", "skillsTested", "expectedTopics", "whyThisQuestion", "followUps", ...Object.keys(extra)],
  );

/** generateQuestionsPrompt: the questions first, then the short analysis. */
export function questionsShape(): JsonSchema {
  return obj(
    {
      questions: list(
        question({ timeAllocationMinutes: num(), signalsSought: list(str()) }),
      ),
      analysis: obj({ roleUnderstanding: str(), keyCompetencies: list(str()) }),
    },
    ["analysis"],
  );
}

/** nextQuestionPrompt: one question. */
export function nextQuestionShape(): JsonSchema {
  return question();
}

const dimension = obj({ score: num(), note: str() });
const STAR_PART = "present|thin|missing";

/** evaluateAnswerPrompt. Story questions add the STAR read; `askCompetency` when the slot didn't name one. */
export function evaluationShape(opts: { star: boolean; askCompetency: boolean }): JsonSchema {
  const story: Record<string, JsonSchema> = opts.star
    ? {
        starBreakdown: obj({
          situation: str(STAR_PART),
          task: str(STAR_PART),
          action: str(STAR_PART),
          result: str(STAR_PART),
          reflection: str(STAR_PART),
          note: str(),
        }),
        starQuotes: list(obj({ part: str(), quote: str("an exact, contiguous quote from their answer") })),
        ...(opts.askCompetency && { competency: nullable(str("the competency key, or null")) }),
        storyTitle: str(),
      }
    : {};
  return obj(
    {
      score: num(),
      scoreBreakdown: obj({ content: dimension, communication: dimension, behavioral: dimension, strategic: dimension }),
      cap: nullable(obj({ max: num(), reason: str() })),
      rubricApplied: str(),
      ...story,
      skillsAssessed: list(obj({ skill: str(), proficiencyDemonstrated: num(), evidence: str() })),
      validation: obj({ strengths: list(str()), missing: list(str()), redFlags: list(str()) }),
      improvedAnswer: obj({ rewritten: str(), keyChanges: list(str()) }),
      coachingTips: list(obj({ priority: str("high|medium|low"), tip: str() })),
      followUpQuestion: str(),
      suggestedFollowup: str(),
    },
    ["rubricApplied", "followUpQuestion", "suggestedFollowup"],
  );
}

/** finalEvaluationPrompt. Each round type adds its own section (see debriefFraming). */
export function debriefShape(roundType: string): JsonSchema {
  const extra: Record<string, JsonSchema> =
    roundType === "behavioral"
      ? {
          storyBank: list(obj({ competency: str(), story: str(), verdict: str("strong|usable|weak") })),
          missingStories: list(str()),
        }
      : roundType === "technical"
        ? { depthMap: list(obj({ topic: str(), verdict: str("solid|shaky|gap"), evidence: str() })) }
        : roundType === "screen"
          ? { screenVerdict: str(), recruiterNote: str() }
          : {};
  return obj({
    overallScore: num(),
    grade: str(),
    readiness: str(),
    recommendation: str(),
    executiveSummary: str(),
    stageBreakdown: list(obj({ stage: str(), score: num(), verdict: str() })),
    strengths: obj({ top: list(str()), notable: list(str()) }),
    developmentAreas: obj({ critical: list(str()), important: list(str()) }),
    competencyMatrix: list(obj({ competency: str(), score: num(), level: str(), developmentNeeded: bool() })),
    improvementPlan: obj({ immediate: list(obj({ area: str(), action: str(), timeline: str() })) }),
    nextSessionFocus: obj({ skills: list(str()), questionTypes: list(str()), why: str() }),
    ...extra,
  });
}
