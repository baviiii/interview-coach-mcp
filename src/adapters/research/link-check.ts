/**
 * Does a link the model suggested actually open?
 *
 * The coach may name a specific page (a guide, a standard, a free course). A
 * model can misremember an address, so every one is opened before a learner
 * sees it: a page that loads is shown as a direct link, anything else falls
 * back to a web search for the title (see linkSuggestions). Only the status
 * is read, never the page.
 *
 * This is the server opening an address the model wrote, so it is fenced in:
 * https only, a real public hostname (no IP literals, no localhost or internal
 * names), every resolved address public, redirects followed by hand and each
 * hop checked the same way, and a short timeout. Answers are remembered for a
 * day per Lambda copy.
 */

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

const TIMEOUT_MS = 4000;
const MAX_REDIRECTS = 3;
const CACHE_MS = 24 * 60 * 60 * 1000;
const UA = "Mozilla/5.0 (compatible; FaircopyCoach/1.0; link check)";

const cache = new Map<string, { at: number; ok: boolean }>();

/** A hostname we are willing to ask DNS about: named, public-looking, not internal. */
export function plausibleHost(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  if (!h.includes(".") || isIP(h.replace(/^\[|\]$/g, ""))) return false;
  return !/(^|\.)(localhost|local|internal|intranet|home|lan|corp|test|invalid|example)$/.test(h);
}

const hosts = new Map<string, { at: number; ok: boolean }>();

/**
 * True when DNS knows the host. Used for websites the model names for a logo:
 * nothing is fetched from them here, but a domain that doesn't exist is a
 * domain the model made up.
 */
export async function hostExists(host: string): Promise<boolean> {
  const h = host.toLowerCase();
  if (!plausibleHost(h)) return false;
  const hit = hosts.get(h);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.ok;
  let ok = false;
  try {
    await Promise.race([
      lookup(h),
      new Promise((_, reject) => setTimeout(() => reject(new Error("dns timeout")), 2500)),
    ]);
    ok = true;
  } catch {
    ok = false;
  }
  if (hosts.size >= 2000) hosts.delete(hosts.keys().next().value!);
  hosts.set(h, { at: Date.now(), ok });
  return ok;
}

/** True for addresses that must never be fetched: private, loopback, link-local, shared, reserved. */
export function privateAddress(address: string): boolean {
  if (isIP(address) === 6) {
    const a = address.toLowerCase();
    if (a === "::" || a === "::1") return true;
    const mapped = a.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return privateAddress(mapped[1]!);
    // fc00::/7 unique-local, fe80::/10 link-local, ff00::/8 multicast.
    return /^(f[cd]|fe[89ab]|ff)/.test(a);
  }
  const [a, b] = address.split(".").map(Number) as [number, number];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // shared address space (CGNAT)
    (a === 169 && b === 254) || // link-local, including cloud metadata
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224 // multicast and reserved
  );
}

/** A URL that is safe to open: https, a plausible host, and every address it resolves to public. */
async function safeTarget(raw: string): Promise<URL | null> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")) return null;
  if (!plausibleHost(url.hostname)) return null;
  try {
    const addresses = await lookup(url.hostname, { all: true });
    if (!addresses.length || addresses.some((a) => privateAddress(a.address))) return null;
  } catch {
    return null;
  }
  return url;
}

async function status(url: URL, method: "HEAD" | "GET", signal: AbortSignal): Promise<Response> {
  const res = await fetch(url, { method, redirect: "manual", signal, headers: { "User-Agent": UA, Accept: "text/html,*/*" } });
  // The body is never read: cancel it so the connection is freed.
  await res.body?.cancel().catch(() => undefined);
  return res;
}

/** Follows checked redirects to the final page; its URL when that answers 2xx, else null. */
async function finalPage(raw: string, signal: AbortSignal): Promise<URL | null> {
  let url = await safeTarget(raw);
  if (!url) return null;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    let res = await status(url, "HEAD", signal);
    // Some servers refuse HEAD; ask again the ordinary way.
    if (res.status === 405 || res.status === 403 || res.status === 501) res = await status(url, "GET", signal);
    if (res.status >= 200 && res.status < 300) return url;
    const location = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
    if (!location) return null;
    const next = await safeTarget(new URL(location, url).toString());
    if (!next) return null;
    url = next;
  }
  return null;
}

const TITLE_BYTES = 64 * 1024;

/** The page's <title>, read from at most its first 64 KB; null when there isn't one. */
async function titleOf(url: URL, signal: AbortSignal): Promise<string | null> {
  const res = await fetch(url, { redirect: "manual", signal, headers: { "User-Agent": UA, Accept: "text/html" } });
  if (res.status < 200 || res.status >= 300 || !res.body) {
    await res.body?.cancel().catch(() => undefined);
    return null;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let html = "";
  try {
    while (html.length < TITLE_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      html += decoder.decode(value, { stream: true });
      if (/<\/title>/i.test(html)) break;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.replace(/\s+/g, " ").trim();
  return title || null;
}

/**
 * Some sites answer "200 OK" for pages that don't exist (seen: ahpra.gov.au),
 * so a status proves nothing there. Asking such a site for a page that can't
 * exist shows what its "missing" page looks like; a named page with a
 * different title is real. Remembered a day per site.
 */
const hostChecks = new Map<string, { at: number; missingTitle: string | null; lies: boolean }>();
async function missingPageOf(origin: string, signal: AbortSignal): Promise<{ lies: boolean; missingTitle: string | null }> {
  const hit = hostChecks.get(origin);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit;
  const probe = await finalPage(`${origin}/faircopy-link-check-${crypto.randomUUID()}`, signal);
  const entry = { at: Date.now(), lies: probe !== null, missingTitle: probe ? await titleOf(probe, signal) : null };
  hostChecks.set(origin, entry);
  return entry;
}

async function check(raw: string): Promise<boolean> {
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  try {
    const page = await finalPage(raw, signal);
    if (!page) return false;
    const askedForFrontPage = new URL(raw).pathname === "/";
    if (page.pathname === "/") {
      // A deep link that lands on the front page is a missing page in disguise;
      // a front page that loads is just a front page.
      return askedForFrontPage;
    }
    const site = await missingPageOf(page.origin, signal);
    if (!site.lies) return true;
    const title = await titleOf(page, signal);
    return Boolean(title && site.missingTitle && title !== site.missingTitle);
  } catch {
    return false;
  }
}

/** Whether the page at `url` really opens (2xx, at most three checked redirects, on a site that 404s). Never throws. */
export async function linkOpens(url: string): Promise<boolean> {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.ok;
  const ok = await check(url);
  cache.set(url, { at: Date.now(), ok });
  return ok;
}
