import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { hostExists } from "../adapters/research/link-check.js";
import { plainDomain } from "../domain/certifications.js";
import { brandSitesPrompt } from "../domain/prompts.js";
import * as S from "../schemas.js";
import { ok } from "./_util.js";
import type { ToolDeps } from "./interview.js";

/**
 * The organisation behind each skill, certification, tool or line of advice
 * on the page, as a website, so the site can show its logo. For any field:
 * nursing registration → ahpra.gov.au, CPA → cpaaustralia.com.au, Terraform →
 * hashicorp.com. General skills get null, so no logo.
 *
 * One fast model call for the names it hasn't seen; every answer is kept for
 * 30 days per Lambda copy and shared by everyone (names aren't personal, and
 * the browser keeps its own copy too). A domain is only kept if it's a plain
 * domain and DNS knows it: a made-up one is dropped, never shown.
 */

const TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_CACHED = 5000;
const cache = new Map<string, { at: number; domain: string | null }>();

/** How a name is filed: trimmed, spaces collapsed, lower case. */
export function brandKey(name: string): string {
  return name.trim().replace(/\s+/g, " ").toLowerCase().slice(0, 300);
}

function remembered(key: string): { domain: string | null } | null {
  const hit = cache.get(key);
  return hit && Date.now() - hit.at < TTL_MS ? hit : null;
}

function remember(key: string, domain: string | null): void {
  if (cache.size >= MAX_CACHED) cache.delete(cache.keys().next().value!);
  cache.set(key, { at: Date.now(), domain });
}

/** The model's answer, item by item: a checked domain, or null. */
export async function readBrandSites(
  items: string[],
  raw: unknown,
  exists: (host: string) => Promise<boolean> = hostExists,
): Promise<Map<number, string | null>> {
  const sites = (raw && typeof raw === "object" ? (raw as { sites?: unknown }).sites : null) ?? [];
  const out = new Map<number, string | null>();
  const answers = (Array.isArray(sites) ? sites : []).flatMap((s) => {
    if (!s || typeof s !== "object") return [];
    const o = s as { id?: unknown; domain?: unknown };
    const i = Number(String(o.id ?? "").replace(/[^\d]/g, "")) - 1;
    return Number.isInteger(i) && i >= 0 && i < items.length ? [{ i, domain: plainDomain(o.domain) }] : [];
  });
  await Promise.all(
    answers.map(async ({ i, domain }) => {
      out.set(i, domain && (await exists(domain)) ? domain : null);
    }),
  );
  // Anything the model skipped counts as "no organisation".
  for (let i = 0; i < items.length; i++) if (!out.has(i)) out.set(i, null);
  return out;
}

export function registerBrandTools(server: McpServer, deps: ToolDeps): void {
  const { horus, auth } = deps;

  server.registerTool(
    "find_brand_sites",
    {
      title: "Find the organisation behind names on the page",
      description:
        "For skills, certifications, licences, tools or lines of advice, the main website of the organisation each is chiefly about (the awarding body, the maker of a tool), so the site can show its logo. Works for any field. null for general skills and when unsure. Remembered for 30 days.",
      inputSchema: S.brandSitesInput,
    },
    async (args) => {
      const sites: Record<string, string | null> = {};
      const unseen: string[] = [];
      for (const name of args.names) {
        const key = brandKey(name);
        const hit = remembered(key);
        if (hit) sites[name] = hit.domain;
        else if (!unseen.some((u) => brandKey(u) === key)) unseen.push(name);
      }

      let reason: string | undefined;
      if (unseen.length > 0) {
        try {
          const { system, user, schema } = brandSitesPrompt(unseen);
          const res = await horus.infer<unknown>({
            task: "brand.sites",
            expect: ["sites"],
            schema,
            schemaName: "BrandSites",
            system,
            messages: [{ role: "user", content: user }],
            model: "fast",
            temperature: 0.1,
            userRef: auth.userId,
            userToken: auth.jwt,
          });
          const found = await readBrandSites(unseen, res.data);
          unseen.forEach((name, i) => {
            const domain = found.get(i) ?? null;
            remember(brandKey(name), domain);
            sites[name] = domain;
          });
        } catch (e) {
          // Not remembered, so the next visit asks again; the site falls back to its own list.
          reason = `lookup unavailable: ${(e as Error).message}`.slice(0, 200);
        }
      }

      // Every name asked about, in the casing it was asked with.
      for (const name of args.names) if (!(name in sites)) {
        const hit = remembered(brandKey(name));
        if (hit) sites[name] = hit.domain;
      }
      return ok({ sites, ...(reason ? { _meta: { reason } } : {}) });
    },
  );
}
