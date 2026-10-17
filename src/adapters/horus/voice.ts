/**
 * Spoken answers. Horus holds the speech service; this server only asks it for
 * a short-lived key for one signed-in learner, and the browser then streams the
 * microphone to the speech service directly (WebRTC) and gets the transcript
 * back as it speaks. No audio passes through this server, and the browser
 * never holds a long-lived secret.
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

export async function mintVoiceSession(opts: { userRef: string }): Promise<VoiceSession> {
  if (config.horus.mode !== "http" || !config.horus.baseUrl || !config.horus.apiKey) {
    throw new AppError("Spoken answers aren't available on this server.", 503);
  }
  let res: Response;
  try {
    res = await fetch(`${config.horus.baseUrl.replace(/\/$/, "")}/voice/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.horus.apiKey}` },
      body: JSON.stringify({ purpose: "interview_answer", userRef: opts.userRef }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new AppError("Couldn't reach the speech service.", 502);
  }
  if (!res.ok) {
    // 503 from Horus means "not configured there" — say that, not "broken".
    throw new AppError(
      res.status === 503 ? "Spoken answers aren't switched on yet." : "Couldn't start a spoken answer.",
      res.status === 503 ? 503 : 502,
    );
  }
  const body = (await res.json()) as Partial<VoiceSession>;
  if (!body.ephemeralKey || !body.webrtcUrl) throw new AppError("Couldn't start a spoken answer.", 502);
  return { ephemeralKey: body.ephemeralKey, webrtcUrl: body.webrtcUrl, expiresAt: body.expiresAt };
}
