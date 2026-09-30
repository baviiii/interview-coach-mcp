/** Difficulty ladder shared by the interview loop and adaptive follow-ups. */

export const DIFFICULTIES = ["easy", "medium", "hard", "expert"] as const;
export type Difficulty = (typeof DIFFICULTIES)[number];
