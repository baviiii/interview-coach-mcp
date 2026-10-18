/**
 * Spoken answers. Horus holds the speech service; this server only asks for a
 * short-lived key for one signed-in learner, and the browser then streams the
 * microphone to the speech service directly (WebRTC) and gets the transcript
 * back as it speaks. No audio passes through this server, and the browser
 * never holds a long-lived secret.
 *
 * The request goes where /infer goes: CareerCraft's functions URL, whose
 * voice-session function holds the Horus key, checks this server's key AND
 * the learner's own token, applies a per-person limit kept in the database,
 * and asks Horus to mint. HORUS_VOICE_URL overrides the address.
 *
 * Voice is off unless Horus is the model provider (HORUS_MODE=http) and has a
 * key: mock and gateway modes have nothing to mint from.
 */

import { config } from "../../config.js";
import { AppError } from "../../errors.js";

export interface VoiceSession {
  /** Short-lived key for this one session. */
  ephemeralKey: string;
  /** Where the browser opens the WebRTC call. */
  webrtcUrl: string;
  /** Unix seconds, when Horus says. */
  expiresAt?: number;
}

/** Where to ask: the explicit override, else the voice-session function beside /infer. */
export function voiceSessionUrl(): string | null {
  if (config.horus.voiceUrl) return config.horus.voiceUrl;
  return config.horus.baseUrl ? `${config.horus.baseUrl.replace(/\/$/, "")}/voice-session` : null;
}

export async function mintVoiceSession(opts: { userRef: string; userToken: string }): Promise<VoiceSession> {
  const url = voiceSessionUrl();
  if (config.horus.mode !== "http" || !url || !config.horus.apiKey) {
    throw new AppError("Spoken answers aren't available on this server.", 503);
  }
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // This server's key says who is calling; the learner's token says for
        // whom — the voice-session function requires both.
        Authorization: `Bearer ${config.horus.apiKey}`,
        "x-functions-key": config.horus.apiKey,
        "x-user-token": opts.userToken,
        "x-tenant": config.horus.tenant,
      },
      body: JSON.stringify({ purpose: "interview_answer", userRef: opts.userRef }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new AppError("Couldn't reach the speech service.", 502);
  }
  if (!res.ok) {
    // 503 means "not configured there" — say that, not "broken"; 429 is the
    // learner's own hourly limit.
    if (res.status === 503) throw new AppError("Spoken answers aren't switched on yet.", 503);
    if (res.status === 429) throw new AppError("You've started a lot of spoken answers this hour. Type this one, or try again later.", 429);
    console.warn(`[voice] mint failed: HTTP ${res.status}`);
    throw new AppError("Couldn't start a spoken answer.", 502);
  }
  const body = (await res.json()) as Partial<VoiceSession>;
  if (!body.ephemeralKey || !body.webrtcUrl) throw new AppError("Couldn't start a spoken answer.", 502);
  return { ephemeralKey: body.ephemeralKey, webrtcUrl: body.webrtcUrl, expiresAt: body.expiresAt };
}
