/**
 * Checks that every table, column and database function in src/schema-used.ts
 * still exists in the live CareerCraft database.
 *
 * Each column is asked for with zero rows (`?select=<col>&limit=0`) using the
 * public anon key. PostgREST validates the column before row-level security
 * applies, so a missing column answers 42703 and a missing table PGRST205 —
 * without reading anyone's data. A function is called with no arguments: a
 * missing one answers PGRST202, an existing one is refused for the anon role.
 *
 *   npm run schema-check        (reads SUPABASE_URL / SUPABASE_ANON_KEY from .env)
 */
import "dotenv/config";

import { FUNCTIONS_USED, TABLES_USED } from "../src/schema-used.js";

const url = process.env.SUPABASE_URL?.replace(/\/$/, "");
const key = process.env.SUPABASE_ANON_KEY;

if (!url || !key) {
  const msg = "SUPABASE_URL / SUPABASE_ANON_KEY not set — schema check skipped.";
  // Required where it's the whole point (the scheduled watch); a warning elsewhere.
  if (process.env.SCHEMA_CHECK_REQUIRED === "1") {
    console.error(`::error::${msg}`);
    process.exit(1);
  }
  console.warn(`::warning::${msg}`);
  process.exit(0);
}

type Outcome = { item: string; ok: boolean; detail: string };

async function probe(path: string, init?: RequestInit): Promise<{ status: number; code?: string; message?: string }> {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(`${url}/rest/v1/${path}`, {
        ...init,
        headers: { apikey: key!, "Content-Type": "application/json", ...(init?.headers ?? {}) },
        signal: AbortSignal.timeout(20_000),
      });
      const body = (await res.json().catch(() => ({}))) as { code?: string; message?: string };
      return { status: res.status, code: body.code, message: body.message };
    } catch (e) {
      if (attempt >= 3) return { status: 0, message: (e as Error).message };
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
}

async function checkColumn(table: string, column: string): Promise<Outcome> {
  const item = `${table}.${column}`;
  const r = await probe(`${table}?select=${encodeURIComponent(column)}&limit=0`);
  if (r.status === 200) return { item, ok: true, detail: "" };
  if (r.code === "42703") return { item, ok: false, detail: "column does not exist" };
  if (r.code === "PGRST205" || r.code === "42P01") return { item, ok: false, detail: "table does not exist" };
  return { item, ok: false, detail: `unexpected ${r.status} ${r.code ?? ""} ${r.message ?? ""}`.trim() };
}

async function checkFunction(name: string): Promise<Outcome> {
  const item = `function ${name}()`;
  const r = await probe(`rpc/${name}`, { method: "POST", body: "{}" });
  if (r.code === "PGRST202") return { item, ok: false, detail: "function does not exist" };
  if (r.status === 0) return { item, ok: false, detail: `unreachable: ${r.message}` };
  // Any other answer (permission denied for anon, argument errors) means it exists.
  return { item, ok: true, detail: "" };
}

/** Run probes a few at a time: enough to be quick, few enough to be polite. */
async function inBatches<T>(jobs: Array<() => Promise<T>>, size = 8): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < jobs.length; i += size) out.push(...(await Promise.all(jobs.slice(i, i + size).map((j) => j()))));
  return out;
}

const jobs = [
  ...Object.entries(TABLES_USED).flatMap(([table, columns]) => columns.map((c) => () => checkColumn(table, c))),
  ...FUNCTIONS_USED.map((f) => () => checkFunction(f)),
];
const results = await inBatches(jobs);
const missing = results.filter((r) => !r.ok);

console.log(`Schema check: ${results.length - missing.length}/${results.length} present in ${new URL(url).host}`);
if (missing.length > 0) {
  for (const m of missing) console.error(`::error::missing: ${m.item} — ${m.detail}`);
  console.error(
    "\nThe database doesn't match what this server uses. Either a CareerCraft migration removed or renamed something " +
      "(update the code and src/schema-used.ts, or the migration), or a migration this server needs hasn't been " +
      "applied yet (`supabase db push` in careercraft-pages before deploying).",
  );
  process.exit(1);
}
