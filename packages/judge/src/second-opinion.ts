import { isCompleteVerdict, type Judge, type SecondOpinion } from "./types";

// The facilitator adjudicates without the user's question, seller or URL.
export const NOT_AVAILABLE = "(not available to the facilitator)";

/**
 * Adapts a Judge to the facilitator's SecondOpinion. Returns undefined unless the
 * model answered: `adjudicate` reads a partial verdict as disagreement and would
 * reject a valid claim, while undefined leads to CONTESTED.
 */
export function secondOpinionFrom(judge: Judge): SecondOpinion {
  return async ({ promise, title, mimeType, body }) => {
    try {
      const { verdict, details } = await judge.judgeDelivery({
        userQuestion: NOT_AVAILABLE,
        offer: { seller: NOT_AVAILABLE, title, promise },
        body,
        mimeType,
        url: NOT_AVAILABLE,
      });
      if (details.error || !isCompleteVerdict(verdict)) return undefined;
      // Usefulness was judged against a placeholder question, so it is left out.
      return { model: verdict.model, promise: verdict.promise, injection: verdict.injection };
    } catch {
      return undefined;
    }
  };
}
