import type { InboxItem, FilterConfig } from "./workflow";
import { readSecret } from "./state";

const ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const MODEL = "jev-latest";
const QUESTION_ID = "needs_personal_reply";
const MAX_STATE_CHARS = 24_000;

/** Ask TypeSafe Jev whether one bounded inbox conversation needs a personal reply. */
export async function evaluateWithJev(
  item: InboxItem,
  filter: FilterConfig,
): Promise<{ probability: number; modelVersion: string }> {
  const apiKey = await readSecret("jev-api-key");
  if (!apiKey) throw new Error("JEV_NOT_CONFIGURED");

  const state = JSON.stringify({
    title: item.title.slice(0, 500),
    sender: item.sender.slice(0, 250),
    message: item.text.slice(0, 12_000),
    context: item.context.slice(-12).map((message) => ({
      sender: message.sender.slice(0, 250),
      text: message.text.slice(0, 850),
      receivedAt: message.receivedAt,
      isOwn: message.isOwn,
    })),
    isOwn: item.isOwn,
    ownerReplied: item.ownerReplied,
  }).slice(0, MAX_STATE_CHARS);

  const response = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      state,
      model: MODEL,
      questions: {
        [QUESTION_ID]: { type: "noul", instructions: filter.question },
      },
    }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`JEV_HTTP_${response.status}`);

  const result: unknown = await response.json();
  if (!result || typeof result !== "object") throw new Error("JEV_INVALID_RESPONSE");
  const body = result as {
    model?: unknown;
    answers?: Record<string, { noul?: unknown } | undefined>;
  };
  const probability = body.answers?.[QUESTION_ID]?.noul;
  if (typeof probability !== "number" || !Number.isFinite(probability) || probability < 0 || probability > 1) {
    throw new Error("JEV_INVALID_RESPONSE");
  }
  if (typeof body.model !== "string" || !body.model) throw new Error("JEV_INVALID_RESPONSE");
  return { probability, modelVersion: body.model };
}
