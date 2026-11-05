/**
 * Where Study's two web rows look, and what they never show.
 *
 * "What people say" searches only discussion sites: real practitioners
 * talking about doing and learning the work. "Courses & guides" searches the
 * whole web minus sites that are never a good lesson — social feeds, homework
 * mills, shops, login walls — and minus the sites the other rows already
 * cover (YouTube has its own row; forums have theirs). The coach then judges
 * what's left (webPickPrompt).
 */

/** Discussion sites, general and by trade. Root domains match their subdomains. */
export const DISCUSSION_SITES = [
  "reddit.com",
  "whirlpool.net.au",
  "allnurses.com",
  "electriciantalk.com",
  "mikeholt.com",
  "contractortalk.com",
  "plumbingzone.com",
  "hvac-talk.com",
  "community.tes.com",
  "stackexchange.com",
  "stackoverflow.com",
  "news.ycombinator.com",
];

/** Never a course or guide worth sending a learner to. */
export const GUIDE_EXCLUDED_SITES = [
  "youtube.com",
  "reddit.com",
  "pinterest.com",
  "facebook.com",
  "instagram.com",
  "tiktok.com",
  "x.com",
  "twitter.com",
  "quora.com",
  "linkedin.com",
  "amazon.com",
  "amazon.com.au",
  "ebay.com",
  "ebay.com.au",
  "coursehero.com",
  "chegg.com",
  "scribd.com",
  "studocu.com",
  "slideshare.net",
  "issuu.com",
];

/** What practitioners ask when they're getting better at it. */
export function discussionQuery(skill: string, field: string): string {
  return `${skill} tips ${field} how did you learn`.slice(0, 200);
}

/** A free way to learn it, for this job. */
export function guideQuery(skill: string, field: string): string {
  return `learn ${skill} for ${field} free course or guide`.slice(0, 200);
}
