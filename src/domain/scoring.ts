/**
 * How an answer's score is made — the deterministic half of evaluation.
 *
 * The model judges: it scores four dimensions and says whether a hard rule
 * caps the answer. Everything that can be computed instead of guessed is
 * computed here: the weights for this kind of question, the overall score
 * (weighted dimensions, then any cap), where each STAR part sits in the
 * candidate's own words, and how often they said "I" against "we".
 *
 * That split is what lets the UI show its working. "6.8" is the weighted sum
 * of the bars on screen, or the cap and its reason — never a number the
 * model produced for reasons nobody can see.
 */

import { SCREEN_TYPES } from "./interview-loop.js";

export const DIMENSIONS = ["content", "communication", "behavioral", "strategic"] as const;
export type Dimension = (typeof DIMENSIONS)[number];

export type RubricKind = "story" | "fit" | "practical" | "technical" | "situational" | "screen" | "general";

export interface Rubric {
  kind: RubricKind;
  /** Fractions that sum to 1. */
  weights: Record<Dimension, number>;
  /** What each dimension means for this kind of question — goes into the prompt. */
  meaning: Record<Dimension, string>;
  /** The same, in two or three words, for the score bars. */
  short: Record<Dimension, string>;
  emphasis: string;
  /** Whether STAR(R) applies: stories get a STAR breakdown, quotes and an ownership count. */
  star: boolean;
}

/** What a recruiter is listening for in each part of a phone screen. */
const SCREEN_EMPHASIS: Record<(typeof SCREEN_TYPES)[number], string> = {
  pitch:
    "Recruiters stop listening after about 90 seconds. A pitch that recites the whole CV, never says what they want next, or never says why they're looking cannot score above 5.",
  motivation:
    "Generic enthusiasm (\"I'm passionate about…\") with nothing from the ad or the employer caps the score at 5; naming something specific in the role and tying it to their own direction scores well.",
  experience:
    "One concrete example with a result beats a list of duties. A recruiter needs a yes with proof, briefly — not a full STAR essay.",
  salary:
    "A strong answer gives a researched range (or a floor), says whether it's base or package including super, and leaves room to talk. Refusing to give any number, or naming a figure well under the market for no reason, caps the score at 5. Asking politely about the role's budget first is fine if they still give a range.",
  logistics:
    "Clear, specific facts: notice period, when they could start, working rights in Australia, location or hybrid fit. Vague, contradictory or missing logistics cap the score at 5.",
  questions:
    "One or two specific questions about the role, the team or the next steps score well. \"No questions\", or only asking about pay and leave, scores low.",
};

/**
 * Where a question sits: a full interview opens and closes on motivation and
 * fit ("why this role", "your first 90 days"), which is not a story. Graded
 * as STAR it would be marked down for a missing Result and filed in the story
 * library. A behavioural round's opener and closer do ask for a past
 * situation, so they stay stories.
 */
export interface QuestionPlace {
  stage?: string;
  roundType?: string;
}

const FIT_RUBRIC: Rubric = {
  kind: "fit",
  weights: { content: 0.35, communication: 0.3, behavioral: 0.15, strategic: 0.2 },
  meaning: {
    content: "specifics — something real from their own background, and something real about this role",
    communication: "clear, concise and conversational",
    behavioral: "confidence and self-awareness",
    strategic: "direction — how well what they want lines up with this role",
  },
  short: { content: "Specifics", communication: "Clarity", behavioral: "Self-awareness", strategic: "Direction" },
  emphasis:
    "Specific beats polished: tie their own background or plan to this role and this employer. An answer that would fit any employer cannot score above 6.",
  star: false,
};

/**
 * Rubric weights by question type. A behavioural answer graded on "content 40%"
 * scores badly for the wrong reason, and a system-design answer graded on STAR
 * is nonsense — so the weights move with the question while the four reported
 * dimensions stay stable for the UI.
 */
export function rubricFor(questionType?: string, place: QuestionPlace = {}): Rubric {
  const t = (questionType ?? "").toLowerCase();
  const screenPart = SCREEN_TYPES.find((p) => p === t);
  if (screenPart) {
    return {
      kind: "screen",
      weights: { content: 0.35, communication: 0.35, behavioral: 0.15, strategic: 0.15 },
      meaning: {
        content: "relevance and substance for a recruiter",
        communication: "clear, concise and conversational",
        behavioral: "confidence and professionalism",
        strategic: "positioning: how easy they've made it to put them forward",
      },
      short: { content: "Relevance", communication: "Clarity", behavioral: "Confidence", strategic: "Positioning" },
      emphasis: SCREEN_EMPHASIS[screenPart],
      star: false,
    };
  }
  if ((place.stage === "warmup" || place.stage === "closing") && place.roundType !== "behavioral") return FIT_RUBRIC;
  if (/behavior|warmup|closing|leadership/.test(t)) {
    return {
      kind: "story",
      weights: { content: 0.25, communication: 0.25, behavioral: 0.35, strategic: 0.15 },
      meaning: {
        content: "substance of the story",
        communication: "communication and structure",
        behavioral: "behavioural evidence — STAR completeness, ownership, specificity",
        strategic: "strategic impact — the measurable result and what they learned",
      },
      short: { content: "Substance", communication: "Structure", behavioral: "STAR evidence", strategic: "Result & learning" },
      emphasis:
        'A story without a specific situation, their OWN actions ("we" everywhere is a red flag) and a concrete outcome cannot score above 5, however fluent it sounds.',
      star: true,
    };
  }
  if (/practical|hands_on/.test(t)) {
    return {
      kind: "practical",
      weights: { content: 0.45, communication: 0.2, behavioral: 0.15, strategic: 0.2 },
      meaning: {
        content: "a correct, safe, standards-compliant approach",
        communication: "can they walk someone through it step by step",
        behavioral: "when they would check, escalate or stop",
        strategic: "judgment about constraints, risk and priorities",
      },
      short: { content: "Correct & safe", communication: "Step by step", behavioral: "Checks & escalation", strategic: "Judgement" },
      emphasis:
        "Score what they would actually DO, in order. Skipping a safety, legal or quality check this field treats as non-negotiable caps the score at 5, however confident the answer sounds.",
      star: false,
    };
  }
  if (/technical|coding|system_design|design/.test(t)) {
    return {
      kind: "technical",
      weights: { content: 0.45, communication: 0.2, behavioral: 0.1, strategic: 0.25 },
      meaning: {
        content: "correctness and technical depth",
        communication: "how clearly they reason aloud",
        behavioral: "how they handle uncertainty and pushback",
        strategic: "trade-offs, constraints and impact",
      },
      short: { content: "Correctness", communication: "Reasoning aloud", behavioral: "Handling unknowns", strategic: "Trade-offs" },
      emphasis:
        "Reward naming real trade-offs and failure modes; penalise buzzword recall with no mechanism behind it. A confidently wrong claim is worse than an acknowledged unknown.",
      star: false,
    };
  }
  if (/situational|case/.test(t)) {
    return {
      kind: "situational",
      weights: { content: 0.35, communication: 0.25, behavioral: 0.2, strategic: 0.2 },
      meaning: {
        content: "quality of judgment and the options considered",
        communication: "structure of the reasoning",
        behavioral: "stakeholder awareness",
        strategic: "risk, second-order effects, what they'd do first",
      },
      short: { content: "Judgement", communication: "Structure", behavioral: "Stakeholders", strategic: "Risk & priorities" },
      emphasis: "There is no single right answer; score the reasoning, the trade-offs surfaced, and whether they committed to a decision.",
      star: false,
    };
  }
  return {
    kind: "general",
    weights: { content: 0.4, communication: 0.3, behavioral: 0.2, strategic: 0.1 },
    meaning: { content: "content", communication: "communication", behavioral: "behaviour", strategic: "strategic impact" },
    short: { content: "Content", communication: "Communication", behavioral: "Behaviour", strategic: "Impact" },
    emphasis: "Be constructive and specific.",
    star: false,
  };
}

/** "content — correctness and technical depth (45%), …" for the prompt. */
export function weightsText(r: Rubric): string {
  return DIMENSIONS.map((d) => `${d} — ${r.meaning[d]} (${Math.round(r.weights[d] * 100)}%)`).join(", ");
}

/* ── the overall score ────────────────────────────────────────────────── */

export interface ScoreCap {
  max: number;
  reason: string;
}

export interface ScoreDimension {
  key: Dimension;
  label: string;
  weight: number;
  /** 0–10 as the evaluator gave it. */
  score: number;
  note: string;
}

export interface ScoreBuild {
  dimensions: ScoreDimension[];
  /** Σ weight × score, before any cap. */
  weighted: number;
  cap: ScoreCap | null;
  /** What the learner is told they scored: weighted, then capped. */
  final: number;
  /** True when the dimensions were incomplete and the model's own overall had to stand in. */
  fellBack: boolean;
}

const round1 = (n: number) => Math.round(n * 10) / 10;
const clamp10 = (n: number) => Math.max(0, Math.min(10, n));

function dimensionScore(raw: unknown): { score: number | null; note: string } {
  if (typeof raw === "number" && Number.isFinite(raw)) return { score: clamp10(raw), note: "" };
  if (raw && typeof raw === "object") {
    const { score, note } = raw as { score?: unknown; note?: unknown };
    return {
      score: typeof score === "number" && Number.isFinite(score) ? clamp10(score) : null,
      note: typeof note === "string" ? note.trim() : "",
    };
  }
  return { score: null, note: "" };
}

/** A cap only counts if it's a real number below 10 with a stated reason. */
export function readCap(raw: unknown): ScoreCap | null {
  if (!raw || typeof raw !== "object") return null;
  const { max, reason } = raw as { max?: unknown; reason?: unknown };
  if (typeof max !== "number" || !Number.isFinite(max) || max >= 10 || max < 0) return null;
  if (typeof reason !== "string" || !reason.trim()) return null;
  return { max: clamp10(max), reason: reason.trim() };
}

/**
 * The overall score, from the evaluator's dimensions and this rubric's weights.
 * If any dimension is missing the model's own overall stands in (and we say so)
 * — a partial breakdown would otherwise silently weight the rest up.
 */
export function buildScore(rubric: Rubric, breakdown: unknown, cap: unknown, modelScore: unknown): ScoreBuild {
  const parsed = DIMENSIONS.map((key) => {
    const { score, note } = dimensionScore((breakdown as Record<string, unknown> | undefined)?.[key]);
    return { key, label: rubric.short[key], weight: rubric.weights[key], score, note };
  });
  const complete = parsed.every((d) => d.score !== null);
  const dimensions = parsed.map((d) => ({ ...d, score: d.score ?? 0 }));
  const weighted = round1(dimensions.reduce((sum, d) => sum + d.weight * d.score, 0));
  const fallback = typeof modelScore === "number" && Number.isFinite(modelScore) ? clamp10(modelScore) : weighted;
  const base = complete ? weighted : round1(fallback);
  const capped = readCap(cap);
  return {
    dimensions,
    weighted: complete ? weighted : base,
    cap: capped && capped.max < base ? capped : null,
    final: round1(capped && capped.max < base ? capped.max : base),
    fellBack: !complete,
  };
}

/* ── STAR(R) in their own words ───────────────────────────────────────── */

export const STAR_PARTS = ["situation", "task", "action", "result", "reflection"] as const;
export type StarPart = (typeof STAR_PARTS)[number];

export interface Highlight {
  part: StarPart;
  /** Offsets into the answer exactly as submitted, [start, end). */
  start: number;
  end: number;
}

/** Case-, quote- and whitespace-insensitive view of a string, with a map back to the original. */
function normalise(text: string): { flat: string; map: number[] } {
  let flat = "";
  const map: number[] = [];
  let lastSpace = false;
  for (let i = 0; i < text.length; i += 1) {
    let ch = text[i]!;
    if (/[‘’`]/.test(ch)) ch = "'";
    if (/[“”]/.test(ch)) ch = '"';
    if (/[–—]/.test(ch)) ch = "-";
    if (/\s/.test(ch)) {
      if (lastSpace || flat.length === 0) continue;
      ch = " ";
      lastSpace = true;
    } else {
      lastSpace = false;
    }
    // Lower-casing can lengthen a character (İ → i̇); every unit maps back to i.
    for (const unit of ch.toLowerCase().split("")) {
      flat += unit;
      map.push(i);
    }
  }
  return { flat, map };
}

type Span = { start: number; end: number };

/** Finds quotes in one answer, normalising the answer once. Quotes under 8 characters never match. */
function quoteFinder(answer: string): (quote: unknown) => Span | null {
  const hay = normalise(answer);
  return (quote) => {
    if (typeof quote !== "string") return null;
    const needle = normalise(quote.replace(/^["'\s.…]+|["'\s.…]+$/g, "")).flat;
    if (needle.length < 8) return null;
    const at = hay.flat.indexOf(needle);
    if (at < 0) return null;
    return { start: hay.map[at]!, end: hay.map[at + needle.length - 1]! + 1 };
  };
}

/** Where a quote sits in the answer (ignoring case, quote style and spacing), or null if it isn't there. */
export function findQuote(answer: string, quote: unknown): Span | null {
  return answer ? quoteFinder(answer)(quote) : null;
}

/**
 * Where the evaluator's quotes sit in the answer. A quote that isn't actually
 * in the answer (the model paraphrased, or invented) is dropped rather than
 * highlighted somewhere wrong; overlaps keep the earlier part.
 */
export function locateQuotes(answer: string, quotes: unknown): Highlight[] {
  if (!Array.isArray(quotes) || !answer) return [];
  const find = quoteFinder(answer);
  const found: Highlight[] = [];
  for (const q of quotes.slice(0, 12)) {
    const part = STAR_PARTS.find((p) => p === String((q as { part?: unknown })?.part ?? "").toLowerCase());
    if (!part) continue;
    const span = find((q as { quote?: unknown })?.quote);
    if (!span || found.some((h) => span.start < h.end && span.end > h.start)) continue;
    found.push({ part, ...span });
  }
  return found.sort((a, b) => a.start - b.start);
}

/* ── drills ───────────────────────────────────────────────────────────── */

export const DRILL_MARKS = ["covered", "partial", "missing"] as const;
export type DrillMark = (typeof DRILL_MARKS)[number];

/** The cap for a drill answer that says something wrong or unsafe, however much else it covers. */
export const DRILL_CAP = 4;

export interface DrillPoint {
  /** The ideal-answer point, as the drill stated it. */
  point: string;
  mark: DrillMark;
  /** Where the evidence sits in the answer, when it was found. */
  quote: (Span & { text: string }) | null;
  note: string;
}

export interface DrillScore {
  points: DrillPoint[];
  /** Σ credit / points, 0–1: covered counts 1, partial 0.5. */
  coverage: number;
  cap: ScoreCap | null;
  final: number;
  /** True when there were no ideal points to mark and the model's own score stood in. */
  fellBack: boolean;
}

const DRILL_CREDIT: Record<DrillMark, number> = { covered: 1, partial: 0.5, missing: 0 };
const ONE_STEP_DOWN: Record<DrillMark, DrillMark> = { covered: "partial", partial: "missing", missing: "missing" };

/**
 * A drill's score, from the evaluator's marks against the drill's own ideal
 * points. The model says which points the answer covers and quotes the words
 * that show it; the score is the share of points covered (partial counts
 * half), out of 10. Credit needs evidence: a mark whose quote isn't in the
 * answer drops one step. A wrong or unsafe claim caps the drill at DRILL_CAP.
 */
export function buildDrillScore(
  answer: string,
  idealPoints: string[],
  marks: unknown,
  cap: unknown,
  modelScore: unknown,
): DrillScore {
  const find = quoteFinder(answer);
  const list = Array.isArray(marks) ? marks : [];
  const points: DrillPoint[] = idealPoints.map((point, i) => {
    const raw = (list[i] ?? {}) as { mark?: unknown; quote?: unknown; note?: unknown };
    const said = DRILL_MARKS.find((m) => m === String(raw.mark ?? "").toLowerCase()) ?? "missing";
    const span = said === "missing" ? null : find(raw.quote);
    return {
      point,
      mark: said !== "missing" && !span ? ONE_STEP_DOWN[said] : said,
      quote: span ? { ...span, text: answer.slice(span.start, span.end) } : null,
      note: typeof raw.note === "string" ? raw.note.trim().slice(0, 300) : "",
    };
  });

  const fellBack = points.length === 0;
  const coverage = fellBack ? 0 : points.reduce((sum, p) => sum + DRILL_CREDIT[p.mark], 0) / points.length;
  const base = fellBack
    ? clamp10(typeof modelScore === "number" && Number.isFinite(modelScore) ? modelScore : 0)
    : coverage * 10;
  const reason = (cap as { reason?: unknown } | null | undefined)?.reason;
  const capped = typeof reason === "string" && reason.trim() && base > DRILL_CAP ? { max: DRILL_CAP, reason: reason.trim() } : null;
  return {
    points,
    coverage: round1(coverage * 100) / 100,
    cap: capped,
    final: round1(capped ? DRILL_CAP : base),
    fellBack,
  };
}

/**
 * How often they said "I" against "we". Panels listen for this: a story told
 * in "we" never shows what the candidate did. Counted, not judged.
 */
export function ownershipCounts(answer: string): { i: number; we: number } {
  const words = answer.toLowerCase().replace(/[’‘]/g, "'").match(/[a-z']+/g) ?? [];
  let i = 0;
  let we = 0;
  for (const w of words) {
    if (/^(i|i'm|i've|i'd|i'll|me|my|mine|myself)$/.test(w)) i += 1;
    else if (/^(we|we're|we've|we'd|we'll|us|our|ours|ourselves)$/.test(w)) we += 1;
  }
  return { i, we };
}
