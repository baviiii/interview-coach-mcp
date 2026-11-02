/**
 * Links for the coach's own resource suggestions, so every one opens.
 *
 * The coach may name the exact page for a suggestion. Each address is opened
 * first (linkOpens): one that loads is kept as a direct link; a missing,
 * invented or unreachable one becomes a web search for the title. Learners in
 * Australia also get the two official places to find accredited training for
 * the skills that are normally learned that way.
 */

import { linkOpens } from "../adapters/research/link-check.js";
import { config } from "../config.js";

/** direct: the coach named the page and it opened; search: a web search for it; official: a government training search. */
export type LinkKind = "direct" | "search" | "official";

/**
 * A web search for a suggested resource, scoped to the job and the market, so
 * "Australian Medicines Handbook" finds the real thing in one click. Stable for
 * the same title and job, so it can be saved and marked done like any link.
 */
export function searchUrl(title: string, field?: string | null): string {
  // The job and market narrow the search, unless they're already in it as
  // whole words ("Australian Medicines Handbook" still gets "Australia").
  const has = (part: string) => new RegExp(`\\b${part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(title);
  const extra = [field, config.market].filter((part): part is string => Boolean(part) && !has(part!));
  return `https://duckduckgo.com/?q=${encodeURIComponent([title, ...extra].join(" "))}`;
}

/**
 * Every item gets a link that opens: its own if it loads, else a web search —
 * for the coach's search phrase when it gave one (the title is often an
 * instruction, "Shadow a wound clinic…", which searches badly), else the title.
 */
export async function withCheckedLinks<T extends { title: string; url?: unknown; search?: unknown }>(
  items: T[],
  field: string | null | undefined,
  opens: (url: string) => Promise<boolean> = linkOpens,
): Promise<Array<Omit<T, "url"> & { url: string; linkKind: LinkKind }>> {
  return Promise.all(
    items.map(async (item) => {
      const named = typeof item.url === "string" ? item.url.trim() : "";
      if (named && (await opens(named))) return { ...item, url: named, linkKind: "direct" as const };
      // The phrase already names the material; adding the job would only blur it.
      const phrase = typeof item.search === "string" ? item.search.trim().slice(0, 120) : "";
      const url = phrase ? searchUrl(phrase) : searchUrl(item.title, field);
      return { ...item, url, linkKind: "search" as const };
    }),
  );
}

export interface OfficialTrainingLink {
  /** The learner's skill this is for. */
  skill: string;
  title: string;
  provider: string;
  url: string;
  linkKind: "official";
}

/**
 * Where to find accredited training for a skill in Australia: the national
 * register of accredited units and qualifications, and the government's
 * course search (which lists who runs them, and where). Both take a search
 * phrase in the link (checked by hand 2026-11-02: `searchText` and `q`).
 *
 * Only for skills the coach says are normally gained through accredited
 * training — the register covers vocational training, so a university-level
 * skill finds retail units instead (a nurse's "wound care" lists pharmacy
 * sales units). Australia only; other markets get nothing here.
 */
export function officialTrainingLinks(entries: unknown, market: string = config.market): OfficialTrainingLink[] {
  if (market.trim().toLowerCase() !== "australia" || !Array.isArray(entries)) return [];
  const seen = new Set<string>();
  const out: OfficialTrainingLink[] = [];
  for (const entry of entries) {
    const skill = typeof entry?.skill === "string" ? entry.skill.trim() : "";
    const term = typeof entry?.searchTerm === "string" ? entry.searchTerm.trim().slice(0, 60) : "";
    if (!skill || term.length < 3 || seen.has(term.toLowerCase())) continue;
    seen.add(term.toLowerCase());
    const q = encodeURIComponent(term);
    out.push(
      {
        skill,
        title: `Accredited training: ${term}`,
        provider: "National Training Register (training.gov.au)",
        url: `https://training.gov.au/search?searchText=${q}`,
        linkKind: "official",
      },
      {
        skill,
        title: `Courses near you: ${term}`,
        provider: "Your Career (Australian Government)",
        url: `https://www.yourcareer.gov.au/learn-and-train/courses?q=${q}`,
        linkKind: "official",
      },
    );
    if (seen.size === 3) break;
  }
  return out;
}
