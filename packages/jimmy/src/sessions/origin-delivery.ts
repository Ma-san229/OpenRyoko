import type { Connector, Session } from "../shared/types.js";
import { normalizeDelivery, deliverPublic, type DeliveryContext } from "./reply-disposition.js";
import { logger } from "../shared/logger.js";

/**
 * Deliver an engine result back to the conversation a session originated from
 * (its connector + stored reply_context), independent of what triggered the
 * turn. Used when a turn completes outside the normal connector route:
 *
 *  - orphan Stop hooks (background continuation after the turn resolver died)
 *  - notification-triggered wake-ups (detached job finished, child session
 *    callback) that run through the gateway's web-session path, which has no
 *    connector of its own
 *
 * Without this, a woken Slack session computes its answer and posts it
 * nowhere — the customer thread stays silent (issue #38 follow-up).
 */
export type OriginDeliveryResult =
  /** A public action reached the connector. */
  | "delivered"
  /** Intentionally nothing to post: empty text or disposition "none". */
  | "suppressed"
  /** No addressable origin: web session, unknown connector, or a reply
   *  context without a target. Callers that EXPECT a connector-origin
   *  session must surface this — the conversation cannot be reached. */
  | "no_target"
  /** The connector call failed after retries — the caller MUST surface this. */
  | "failed";

const RETRY_DELAYS_MS = [2_000, 5_000];

export async function deliverToOriginConnector(
  session: Session,
  text: string,
  connectors: Map<string, Connector>,
  retryDelaysMs: number[] = RETRY_DELAYS_MS,
): Promise<OriginDeliveryResult> {
  if (!text.trim()) return "suppressed";
  const connector = session.connector ? connectors.get(session.connector) : undefined;
  if (!connector || !session.replyContext) return "no_target";

  const target = connector.reconstructTarget(session.replyContext);
  // Web sessions store a synthetic replyContext that reconstructs to an empty
  // target — nothing addressable to post to.
  if (!target.channel) return "no_target";

  const meta = (session.transportMeta ?? {}) as Record<string, unknown>;
  const isDM = meta.channelType === "im";
  const ctx: DeliveryContext = {
    // Unsolicited follow-up: never force a SAFE_ACK, just sanitize.
    addressed: false,
    channelExternal: isDM ? false : meta.channelExternal === undefined ? true : meta.channelExternal === true,
    isDM,
    canReact: connector.getCapabilities().reactions,
  };
  const { publicAction } = normalizeDelivery(text, ctx);
  if (publicAction.kind === "none") return "suppressed";

  let lastErr: unknown;
  for (let attempt = 0; attempt <= retryDelaysMs.length; attempt++) {
    try {
      await deliverPublic(connector, target, publicAction);
      return "delivered";
    } catch (err) {
      lastErr = err;
      if (attempt < retryDelaysMs.length) {
        await new Promise((r) => setTimeout(r, retryDelaysMs[attempt]));
      }
    }
  }
  logger.warn(`Origin-connector delivery failed for session ${session.id}: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`);
  return "failed";
}
