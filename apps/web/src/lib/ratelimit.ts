import { schema, type Db } from '@cojiro/db';
import { and, count, eq, gt, lt } from 'drizzle-orm';

const HOUR = 60 * 60 * 1000;

export const LIMITS = {
  report: { limit: 10, windowMs: HOUR },
  feedback: { limit: 5, windowMs: HOUR },
} as const;

/**
 * Sliding-window limiter on the rate_events table. Records the event and
 * returns true when allowed; returns false (recording nothing) when over.
 */
export function rateLimit(
  db: Db,
  kind: string,
  ipHash: string,
  opts: { limit: number; windowMs: number },
  now = Date.now(),
): boolean {
  const { rateEvents } = schema;
  const since = now - opts.windowMs;
  const row = db
    .select({ n: count() })
    .from(rateEvents)
    .where(and(eq(rateEvents.kind, kind), eq(rateEvents.ipHash, ipHash), gt(rateEvents.createdAt, since)))
    .get();
  if ((row?.n ?? 0) >= opts.limit) return false;
  db.insert(rateEvents).values({ kind, ipHash, createdAt: now }).run();
  // Opportunistic cleanup so the table stays small.
  if (Math.random() < 0.02) {
    db.delete(rateEvents).where(lt(rateEvents.createdAt, now - 48 * HOUR)).run();
  }
  return true;
}
