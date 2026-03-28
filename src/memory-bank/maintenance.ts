/**
 * Memory Bank maintenance — DatabasePort-based (v2.0)
 *
 * - TTL enforcement
 * - Ebbinghaus forgetting curve (replaces linear decay)
 * - Memory tiering auto-promotion/demotion
 * - Pattern GC
 * - Data cleanup
 *
 * All functions use DatabasePort, compatible with both SQLite and Postgres.
 */

import type { DatabasePort } from "../db/port";

interface Logger {
  info?(...args: unknown[]): void;
  warn?(...args: unknown[]): void;
}

export interface MaintenanceResult {
  expired: number;
  decayed: number;
  tierChanges: number;
  patternsGC: number;
}

export interface CleanupResult {
  toolEntriesDeleted: number;
  stagingCleared: number;
  conversationsArchived: number;
  vacuumed: boolean;
}

/**
 * Run all maintenance tasks via DatabasePort.
 */
export async function runMaintenanceAsync(port: DatabasePort, logger: Logger): Promise<MaintenanceResult> {
  const expired = await expireFactsAsync(port, logger);
  const decayed = await ebbinghausDecay(port, logger);
  const tierChanges = await autoTiering(port, logger);
  let patternsGC = 0;
  try { patternsGC = await port.cleanupStalePatterns(); } catch {}

  if (expired > 0 || decayed > 0 || tierChanges > 0 || patternsGC > 0) {
    logger.info?.(`memory-bank maintenance: expired=${expired}, decayed=${decayed}, tierChanges=${tierChanges}, patternsGC=${patternsGC}`);
  }
  return { expired, decayed, tierChanges, patternsGC };
}

/**
 * Expire facts where created_at + ttl_days < now.
 */
async function expireFactsAsync(port: DatabasePort, logger: Logger): Promise<number> {
  try {
    const expired = await port.expireFactsByTTL();
    if (expired > 0) {
      logger.info?.(`memory-bank: expired ${expired} facts past TTL`);
    }
    return expired;
  } catch {
    return 0;
  }
}

/**
 * Ebbinghaus Forgetting Curve — replaces linear confidence decay.
 *
 * R = e^(-t/S) where:
 *   R = retention (maps to confidence)
 *   t = time since last access (days)
 *   S = strength (increases with each access via spaced repetition)
 *
 * Each access: S = S + 1
 * Floor: 0.3 (never decay below this)
 */
async function ebbinghausDecay(port: DatabasePort, logger: Logger): Promise<number> {
  const facts = await port.getFactsForDecay();
  const now = Date.now();
  const DAY_MS = 86400000;
  let decayCount = 0;

  for (const fact of facts) {
    const lastAccess = fact.last_accessed_at
      ? new Date(fact.last_accessed_at).getTime()
      : new Date(fact.created_at).getTime();
    const daysSinceAccess = (now - lastAccess) / DAY_MS;

    // Only decay if not accessed recently (>7 days)
    if (daysSinceAccess <= 7) continue;

    const strength = fact.strength ?? 1.0;
    // R = e^(-t/S)
    const retention = Math.exp(-daysSinceAccess / strength);
    // Scale to confidence range [0.3, current]
    const newConf = Math.max(0.3, fact.confidence * retention);

    if (Math.abs(newConf - fact.confidence) > 0.001) {
      try {
        await port.updateFact(fact.id, { confidence: newConf });
        await port.storeRevision(
          fact.id, "decay", null, null,
          `Ebbinghaus decay: ${fact.confidence.toFixed(3)} → ${newConf.toFixed(3)} (t=${daysSinceAccess.toFixed(0)}d, S=${strength.toFixed(1)})`
        );
        decayCount++;
      } catch {}
    }
  }

  if (decayCount > 0) {
    logger.info?.(`memory-bank: Ebbinghaus decay applied to ${decayCount} facts`);
  }
  return decayCount;
}

/**
 * Auto-tiering: promote/demote facts between hot/warm/cold tiers.
 *
 * - Facts accessed >5 times in 7 days → promote to hot (max 20 hot)
 * - Hot facts not accessed in 14 days → demote to warm
 * - Warm facts not accessed in 30 days + confidence < 0.5 → demote to cold
 */
async function autoTiering(port: DatabasePort, logger: Logger): Promise<number> {
  const facts = await port.getFactsForDecay();
  const now = Date.now();
  const DAY_MS = 86400000;
  let changes = 0;

  const hotFacts: typeof facts = [];
  const warmFacts: typeof facts = [];

  for (const f of facts) {
    const tier = f.tier ?? "warm";
    if (tier === "hot") hotFacts.push(f);
    else if (tier === "warm") warmFacts.push(f);
  }

  // Demote hot → warm (not accessed in 14 days)
  for (const f of hotFacts) {
    const lastAccess = f.last_accessed_at ? new Date(f.last_accessed_at).getTime() : new Date(f.created_at).getTime();
    const daysSinceAccess = (now - lastAccess) / DAY_MS;
    if (daysSinceAccess > 14) {
      try {
        await port.updateFactTier(f.id, "warm");
        changes++;
      } catch {}
    }
  }

  // Demote warm → cold (not accessed in 30 days + confidence < 0.5)
  for (const f of warmFacts) {
    const lastAccess = f.last_accessed_at ? new Date(f.last_accessed_at).getTime() : new Date(f.created_at).getTime();
    const daysSinceAccess = (now - lastAccess) / DAY_MS;
    if (daysSinceAccess > 30 && f.confidence < 0.5) {
      try {
        await port.updateFactTier(f.id, "cold");
        changes++;
      } catch {}
    }
  }

  // Promote warm → hot (accessed >5 times + recent)
  const currentHot = hotFacts.length;
  const promotionSlots = Math.max(0, 20 - currentHot + changes);

  if (promotionSlots > 0) {
    const candidates = warmFacts
      .filter(f => (f.access_count ?? 0) >= 5)
      .sort((a, b) => (b.access_count ?? 0) - (a.access_count ?? 0))
      .slice(0, promotionSlots);

    for (const f of candidates) {
      const lastAccess = f.last_accessed_at ? new Date(f.last_accessed_at).getTime() : 0;
      const daysSinceAccess = (now - lastAccess) / DAY_MS;
      if (daysSinceAccess <= 7) {
        try {
          await port.updateFactTier(f.id, "hot");
          changes++;
        } catch {}
      }
    }
  }

  if (changes > 0) {
    logger.info?.(`memory-bank: tiering — ${changes} tier changes`);
  }
  return changes;
}

/**
 * Strengthen a fact's spaced repetition (called on each access).
 * S = S + 1
 */
export async function strengthenFact(port: DatabasePort, factId: number): Promise<void> {
  try {
    const facts = await port.queryFacts({ id: factId });
    if (facts.length === 0) return;
    const current = facts[0].strength ?? 1.0;
    await port.updateFactStrength(factId, current + 1);
  } catch {}
}

/**
 * Periodic maintenance via DatabasePort.
 */
export async function runPeriodicMaintenanceAsync(port: DatabasePort, logger: Logger): Promise<void> {
  await runMaintenanceAsync(port, logger);

  try {
    const deleted = await port.deleteEntries({ entryType: "tool", olderThanDays: 7 });
    if (deleted > 0) logger.info?.(`periodic: purged ${deleted} old tool entries`);
  } catch {}

  try {
    const archived = await port.archiveConversations({ staleOlderThanDays: 7, resolvedOlderThanDays: 7 });
    if (archived > 0) logger.info?.(`periodic: archived ${archived} conversations`);
  } catch {}

  try {
    const stats = await port.getDbStats();
    logger.info?.(`periodic stats: ${JSON.stringify(stats)}`);
  } catch {}
}

// ============================================================================
// Legacy SQLite compatibility (kept for fallback backend)
// ============================================================================

import type { Database } from "better-sqlite3";

/** @deprecated Use runMaintenanceAsync(port, logger) instead. */
export function runMaintenance(db: Database, logger: Logger): { expired: number; decayed: number } {
  let expired = 0;
  try {
    const expiredFacts = db.prepare(`
      SELECT id FROM memory_facts
      WHERE status = 'active' AND ttl_days IS NOT NULL AND expired_at IS NULL
        AND julianday('now') - julianday(created_at) > ttl_days
    `).all() as Array<{ id: number }>;
    if (expiredFacts.length > 0) {
      const stmt = db.prepare("UPDATE memory_facts SET status = 'archived', expired_at = CURRENT_TIMESTAMP WHERE id = ?");
      const txn = db.transaction(() => { for (const f of expiredFacts) stmt.run(f.id); });
      txn();
      expired = expiredFacts.length;
    }
  } catch {}
  try { db.prepare("DELETE FROM patterns WHERE confidence < 0.1 AND updated_at < datetime('now', '-30 days')").run(); } catch {}
  return { expired, decayed: 0 };
}

/** @deprecated Use port.runDataCleanup() instead. */
export function runDataCleanup(db: Database, _logger: Logger): { toolEntriesDeleted: number; stagingCleared: number } {
  let toolEntriesDeleted = 0, stagingCleared = 0;
  try { toolEntriesDeleted = db.prepare("DELETE FROM unified_entries WHERE entry_type = 'tool'").run().changes; } catch {}
  try {
    const s = db.prepare("SELECT count(*) as c FROM vec_entries_staging").get() as any;
    if (s?.c > 0) { db.prepare("DELETE FROM vec_entries_staging").run(); stagingCleared = s.c; }
  } catch {}
  return { toolEntriesDeleted, stagingCleared };
}

/** @deprecated Use runPeriodicMaintenanceAsync instead. */
export function runPeriodicMaintenance(db: Database, logger: Logger, _dbPath: string): void {
  runMaintenance(db, logger);
}
