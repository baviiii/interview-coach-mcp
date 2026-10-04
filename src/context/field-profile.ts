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

// Keyed by market too: the same field has different licences in different countries.
const keyFor = (field: string): string => {
  const f = field
    .toLowerCase()
    .replace(/[^a-z0-9+#]+/g, " ")
    .trim();
  return f ? `${config.market.toLowerCase()}|${f}` : "";
};

export async function resolveFieldProfile(
  horus: ModelProvider,
  field: string | undefined,
  // Metering only. Deliberately nothing learner-specific that could reach the prompt.
  opts: { userRef?: string; userToken?: string } = {},
): Promise<FieldProfile> {
  const name = field?.trim() ?? "";
  const key = keyFor(name);
  if (!key) return neutralProfile(name);

  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < hit.ttl) return hit.val;

  // Cache the promise, not the result, so concurrent tools share one call.
  const entry = { at: Date.now(), ttl: TTL_MS, val: Promise.resolve(neutralProfile(name)) };
  entry.val = derive(horus, name, opts).then((profile) => {
    if (profile.notOccupation) entry.ttl = NOT_OCCUPATION_TTL_MS;
    else if (profile.source === "neutral") cache.delete(key); // a failed lookup: retry next time
    return profile;
  });
  if (cache.size >= MAX_ENTRIES) cache.delete(cache.keys().next().value!);
  cache.set(key, entry);
  return entry.val;
}

async function derive(
  horus: ModelProvider,
  field: string,
  opts: { userRef?: string; userToken?: string },
): Promise<FieldProfile> {
  try {
    const { system, user } = fieldProfilePrompt({ field });
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
