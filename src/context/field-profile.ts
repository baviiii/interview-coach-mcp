import type { ModelProvider } from "../adapters/horus/index.js";
import { config } from "../config.js";
import { neutralProfile, parseFieldProfile, type FieldProfile } from "../domain/field-profile.js";
import { fieldProfilePrompt } from "../domain/prompts.js";

/**
 * Resolves a field's profile once and caches it. How a field hires changes
 * slowly and isn't about any one learner, so a day-long cache means one fast
 * model call per field per replica. Best-effort like research: any failure
 * yields the neutral profile, which is never cached, so the next call retries.
 */
const TTL_MS = 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 500;

const cache = new Map<string, { at: number; val: Promise<FieldProfile> }>();

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
  opts: { role?: string; userRef?: string; userToken?: string } = {},
): Promise<FieldProfile> {
  const name = field?.trim() ?? "";
  const key = keyFor(name);
  if (!key) return neutralProfile(name);

  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.val;

  // Cache the promise, not the result, so concurrent tools share one call.
  const val = derive(horus, name, opts).then((profile) => {
    // A failed lookup is retried next time; "that isn't a job" is an answer, and is kept.
    if (profile.source === "neutral" && !profile.notOccupation) cache.delete(key);
    return profile;
  });
  if (cache.size >= MAX_ENTRIES) cache.delete(cache.keys().next().value!);
  cache.set(key, { at: Date.now(), val });
  return val;
}

async function derive(
  horus: ModelProvider,
  field: string,
  opts: { role?: string; userRef?: string; userToken?: string },
): Promise<FieldProfile> {
  try {
    const { system, user } = fieldProfilePrompt({ field, role: opts.role });
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
