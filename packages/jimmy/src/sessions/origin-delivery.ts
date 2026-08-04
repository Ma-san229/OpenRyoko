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
 *
 * Returns true when a public action was attempted on the connector.
 */
export async function deliverToOriginConnector(
  session: Session,
  text: string,
  connectors: Map<string, Connector>,
): Promise<boolean> {
  if (!text.trim()) return false;
  const connector = session.connector ? connectors.get(session.connector) : undefined;
  if (!connector || !session.replyContext) return false;
  // Web sessions store a synthetic replyContext with no addressable target.
  if (typeof session.replyContext.channel !== "string" || !session.replyContext.channel) return false;

  const target = connector.reconstructTarget(session.replyContext);
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
  if (publicAction.kind === "none") return false;
  try {
    await deliverPublic(connector, target, publicAction);
    return true;
  } catch (err) {
    logger.warn(`Origin-connector delivery failed for session ${session.id}: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}
