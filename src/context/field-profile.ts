import type { ModelProvider } from "../adapters/horus/index.js";
import { config } from "../config.js";
import { neutralProfile, parseFieldProfile, type FieldProfile } from "../domain/field-profile.js";
import { fieldProfilePrompt } from "../domain/prompts.js";

/**
 * Resolves a field's profile once and caches it. How a field hires changes
 * slowly and isn't about any one learner, so a day-long cache means one fast
 * model call per field per replica. Best-effort like research: any failure
 * yields the neutral profile, which is never cached, so the next call retries.
 *
 * The cache is shared by every learner, so a profile must be derived from the
 * field name alone. It once also took the requesting learner's free-text goal,
 * which meant whoever asked first shaped the profile everyone saw — and could
 * write instructions into it.
 */
const TTL_MS = 24 * 60 * 60 * 1000;
/** "Not a job" is kept briefly: enough to absorb retyping, too short for one wrong answer to stick. */
const NOT_OCCUPATION_TTL_MS = 10 * 60 * 1000;
const MAX_ENTRIES = 500;

const cache = new Map<string, { at: number; ttl: number; val: Promise<FieldProfile> }>();

/**
 * The one form of a field that both the cache key and the model see. Keying on
 * a cleaned form while prompting with the raw text let whatever the cleaning
 * dropped — another script, emoji, punctuation — carry instructions into a
 * profile then cached for everyone who typed the plain job name. Letters of
 * every script are kept, so "护士" or "медсестра" are jobs, not empty keys.
 */
export function canonicalField(field: string | undefined): string {
  return (field ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}+#]+/gu, " ")
    .trim()
    .slice(0, 80)
    .trim();
}

const titleCase = (s: string) => s.replace(/(^|\s)\p{L}/gu, (m) => m.toUpperCase());

export async function resolveFieldProfile(
  horus: ModelProvider,
  field: string | undefined,
  // Metering only. Deliberately nothing learner-specific that could reach the prompt.
  opts: { userRef?: string; userToken?: string } = {},
): Promise<FieldProfile> {
  const text = canonicalField(field);
  // Nothing left of it (punctuation only): an answer, not a lookup to retry.
  if (!text) return { ...neutralProfile(field?.trim() ?? ""), notOccupation: true };
  // Keyed by market too: the same field has different licences in different countries.
  const key = `${config.market.toLowerCase()}|${text}`;

  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < hit.ttl) return hit.val;

  // Cache the promise, not the result, so concurrent tools share one call.
  const name = titleCase(text);
  const entry = { at: Date.now(), ttl: TTL_MS, val: Promise.resolve(neutralProfile(name)) };
  entry.val = derive(horus, text, name, opts).then((profile) => {
    if (profile.notOccupation) entry.ttl = NOT_OCCUPATION_TTL_MS;
    else if (profile.source === "neutral") cache.delete(key); // a failed lookup: retry next time
    return profile;
  });
  if (cache.size >= MAX_ENTRIES) cache.delete(cache.keys().next().value!);
  cache.set(key, entry);
  return entry.val;
}

/** `text` is exactly what the cache is keyed on; `field` is how the profile names it. */
async function derive(
  horus: ModelProvider,
  text: string,
  field: string,
  opts: { userRef?: string; userToken?: string },
): Promise<FieldProfile> {
  try {
    const { system, user } = fieldProfilePrompt({ field: text });
    const res = await horus.infer({
      task: "field.profile",
      system,
      messages: [{ role: "user", content: user }],
      model: "fast",
      temperature: 0.2,
      userRef: opts.userRef,
      userToken: opts.userToken,
    });
    return parseFieldProfile(field, res.data) ?? neutralProfile(field);
  } catch (e) {
    console.warn(`[field-profile] falling back to neutral for "${field}": ${(e as Error).message}`);
    return neutralProfile(field);
  }
}
