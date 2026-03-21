/**
 * Memory Bank maintenance — TTL enforcement + confidence decay
 *
 * Called on plugin startup and can be triggered periodically.
 */

import type { Database } from "better-sqlite3";

interface Logger {
  info?(...args: unknown[]): void;
  warn?(...args: unknown[]): void;
}

interface MaintenanceResult {
  expired: number;
  decayed: number;
}

export interface CleanupResult {
  toolEntriesDeleted: number;
  stagingCleared: number;
  conversationsArchived: number;
  vacuumed: boolean;
}

export interface StatsResult {
  totalEntries: number;
  entryBreakdown: Record<string, number>;
  vectorCount: number;
  factsCount: number;
  dbSizeMB: number;
  conversationsActive: number;
}

/**
 * Run all maintenance tasks: TTL expiry + confidence decay.
 */
export function runMaintenance(db: Database, logger: Logger): MaintenanceResult {
  const expired = expireFacts(db, logger);
  const decayed = decayConfidence(db, logger);
  const gcPatterns = cleanupPatterns(db, logger);
  if (expired > 0 || decayed > 0 || gcPatterns > 0) {
    logger.info?.(`memory-bank maintenance: expired=${expired}, decayed=${decayed}, patternsGC=${gcPatterns}`);
  }
  return { expired, decayed };
}

/**
 * Clean up low-confidence stale patterns.
 * Deletes patterns with confidence < 0.1 that haven't been updated in 30+ days.
 */
function cleanupPatterns(db: Database, logger: Logger): number {
  try {
    const result = db.prepare(
      "DELETE FROM patterns WHERE confidence < 0.1 AND updated_at < datetime('now', '-30 days')"
    ).run();
    const deleted = result.changes;
    if (deleted > 0) {
      logger.info?.(`memory-bank: GC'd ${deleted} stale patterns`);
    }
    return deleted;
  } catch {
    return 0;
  }
}

/**
 * Expire facts where created_at + ttl_days < now.
 * Sets expired_at, status='archived', and logs revision.
 */
function expireFacts(db: Database, logger: Logger): number {
  // Find facts that have exceeded their TTL
  const expiredFacts = db.prepare(`
    SELECT id, fact, topic, ttl_days FROM memory_facts
    WHERE status = 'active'
      AND ttl_days IS NOT NULL
      AND expired_at IS NULL
      AND julianday('now') - julianday(created_at) > ttl_days
  `).all() as Array<{ id: number; fact: string; topic: string; ttl_days: number }>;

  if (expiredFacts.length === 0) return 0;

  const updateStmt = db.prepare(
    "UPDATE memory_facts SET status = 'archived', expired_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
  );
  const revisionStmt = db.prepare(
    "INSERT INTO memory_revisions (fact_id, revision_type, old_content, new_content, reason) VALUES (?, 'expired', ?, NULL, ?)"
  );

  const txn = db.transaction(() => {
    for (const fact of expiredFacts) {
      updateStmt.run(fact.id);
      revisionStmt.run(fact.id, fact.fact, `TTL expired (${fact.ttl_days} days)`);
    }
  });
  txn();

  logger.info?.(`memory-bank: expired ${expiredFacts.length} facts past TTL`);
  return expiredFacts.length;
}

/**
 * Apply confidence decay to facts not recently accessed.
 *
 * - >7 days since last access: confidence *= 0.99
 * - >30 days since last access: confidence *= 0.95
 * - Topics with ttl_days=NULL (infinite TTL): decay 2x slower
 * - Never decay below 0.3
 */
function decayConfidence(db: Database, logger: Logger): number {
  // Get all active facts that haven't been accessed recently
  const facts = db.prepare(`
    SELECT f.id, f.confidence, f.last_accessed_at, f.created_at, f.ttl_days,
           t.ttl_days AS topic_ttl_days
    FROM memory_facts f
    LEFT JOIN memory_topics t ON f.topic = t.name
    WHERE f.status = 'active'
      AND f.confidence > 0.3
  `).all() as Array<{
    id: number;
    confidence: number;
    last_accessed_at: string | null;
    created_at: string;
    ttl_days: number | null;
    topic_ttl_days: number | null;
  }>;

  const now = Date.now();
  const DAY_MS = 86400000;
  let decayCount = 0;

  const updateStmt = db.prepare(
    "UPDATE memory_facts SET confidence = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
  );
  const revisionStmt = db.prepare(
    "INSERT INTO memory_revisions (fact_id, revision_type, old_content, new_content, reason) VALUES (?, 'decay', NULL, NULL, ?)"
  );

  const txn = db.transaction(() => {
    for (const fact of facts) {
      const lastAccess = fact.last_accessed_at ? new Date(fact.last_accessed_at).getTime() : new Date(fact.created_at).getTime();
      const daysSinceAccess = (now - lastAccess) / DAY_MS;

      // Determine if this topic has infinite TTL (decay slower)
      const isInfiniteTtl = fact.ttl_days === null && fact.topic_ttl_days === null;

      let decayFactor = 1.0;
      if (daysSinceAccess > 30) {
        decayFactor = isInfiniteTtl ? 0.975 : 0.95; // 2x slower for infinite TTL
      } else if (daysSinceAccess > 7) {
        decayFactor = isInfiniteTtl ? 0.995 : 0.99; // 2x slower for infinite TTL
      }

      if (decayFactor < 1.0) {
        const newConf = Math.max(0.3, fact.confidence * decayFactor);
        if (Math.abs(newConf - fact.confidence) > 0.001) {
          updateStmt.run(newConf, fact.id);
          revisionStmt.run(fact.id, `confidence decay ${fact.confidence.toFixed(3)} -> ${newConf.toFixed(3)} (${daysSinceAccess.toFixed(0)}d since access${isInfiniteTtl ? ", slow decay" : ""})`);
          decayCount++;
        }
      }
    }
  });
  txn();

  if (decayCount > 0) {
    logger.info?.(`memory-bank: decayed confidence for ${decayCount} facts`);
  }
  return decayCount;
}

/**
 * One-time cleanup: remove tool entries, clear staging blobs, vacuum.
 * Safe to call multiple times (idempotent).
 */
export function runDataCleanup(db: Database, logger: Logger): CleanupResult {
  const result: CleanupResult = { toolEntriesDeleted: 0, stagingCleared: 0, conversationsArchived: 0, vacuumed: false };

  try {
    // 1. Delete tool entries from unified_entries (and FTS5 triggers auto-clean)
    const delTool = db.prepare("DELETE FROM unified_entries WHERE entry_type = 'tool'").run();
    result.toolEntriesDeleted = delTool.changes;
    if (result.toolEntriesDeleted > 0) {
      logger.info?.(`cleanup: deleted ${result.toolEntriesDeleted} tool entries`);
    }

    // 2. Clear hnsw_meta for deleted entries
    db.prepare("DELETE FROM hnsw_meta WHERE entry_id NOT IN (SELECT id FROM unified_entries)").run();

    // 3. Clear vec_entries_staging (orphaned embeddings, never promoted)
    try {
      const staging = db.prepare("SELECT count(*) as c FROM vec_entries_staging").get() as any;
      if (staging?.c > 0) {
        db.prepare("DELETE FROM vec_entries_staging").run();
        result.stagingCleared = staging.c;
        logger.info?.(`cleanup: cleared ${result.stagingCleared} staging blobs`);
      }
    } catch {} // table may not exist

    // 4. Archive old resolved conversations (>7 days)
    const archConv = db.prepare(
      "UPDATE conversations SET status = 'archived' WHERE status = 'resolved' AND resolved_at < datetime('now', '-7 days')"
    ).run();
    result.conversationsArchived = archConv.changes;

    // 5. Rebuild FTS5 index (removes orphaned entries from deleted tool rows)
    // If FTS5 is corrupted, drop and recreate it
    try {
      db.exec("INSERT INTO unified_fts(unified_fts) VALUES('rebuild')");
    } catch {
      try {
        db.exec("DROP TABLE IF EXISTS unified_fts");
        db.exec(`
          CREATE VIRTUAL TABLE IF NOT EXISTS unified_fts USING fts5(
            content, summary, tags, hnsw_key,
            content='unified_entries', content_rowid='id'
          );
          INSERT INTO unified_fts(unified_fts) VALUES('rebuild');
        `);
        logger.info?.("cleanup: FTS5 index recreated (was corrupted)");
      } catch (ftsErr) {
        logger.warn?.("cleanup: FTS5 rebuild failed:", String(ftsErr));
      }
    }

    // 6. VACUUM to reclaim disk space
    try {
      db.exec("VACUUM");
      result.vacuumed = true;
      logger.info?.("cleanup: database vacuumed");
    } catch (vacErr) {
      logger.warn?.("cleanup: vacuum failed:", String(vacErr));
    }
  } catch (err) {
    logger.warn?.("cleanup: data cleanup error:", String(err));
  }

  return result;
}

/**
 * Get database stats for monitoring.
 */
export function getDbStats(db: Database, dbPath: string): StatsResult {
  const stats: StatsResult = {
    totalEntries: 0, entryBreakdown: {}, vectorCount: 0,
    factsCount: 0, dbSizeMB: 0, conversationsActive: 0,
  };

  try {
    const total = db.prepare("SELECT count(*) as c FROM unified_entries").get() as any;
    stats.totalEntries = total?.c ?? 0;

    const breakdown = db.prepare(
      "SELECT entry_type, count(*) as c FROM unified_entries GROUP BY entry_type"
    ).all() as any[];
    for (const row of breakdown) {
      stats.entryBreakdown[row.entry_type] = row.c;
    }

    const vecCount = db.prepare("SELECT count(*) as c FROM hnsw_meta").get() as any;
    stats.vectorCount = vecCount?.c ?? 0;

    const facts = db.prepare("SELECT count(*) as c FROM memory_facts WHERE status = 'active'").get() as any;
    stats.factsCount = facts?.c ?? 0;

    const conv = db.prepare("SELECT count(*) as c FROM conversations WHERE status = 'active'").get() as any;
    stats.conversationsActive = conv?.c ?? 0;

    // DB file size
    try {
      const fs = require("fs");
      const stat = fs.statSync(dbPath);
      stats.dbSizeMB = Math.round(stat.size / 1024 / 1024 * 10) / 10;
    } catch {}
  } catch {}

  return stats;
}

/**
 * Periodic maintenance: purge old tool entries, compact conversations, report stats.
 * Designed to be called daily or on startup.
 */
export function runPeriodicMaintenance(db: Database, logger: Logger, dbPath: string): void {
  // 1. Standard maintenance (TTL + decay + pattern GC)
  const mResult = runMaintenance(db, logger);

  // 2. Purge tool entries older than 7 days (selective logging may produce some)
  try {
    const purged = db.prepare(
      "DELETE FROM unified_entries WHERE entry_type = 'tool' AND created_at < datetime('now', '-7 days')"
    ).run();
    if (purged.changes > 0) {
      logger.info?.(`periodic: purged ${purged.changes} old tool entries`);
    }
  } catch {}

  // 3. Archive old conversations (active but untouched for 7+ days)
  try {
    const archived = db.prepare(
      "UPDATE conversations SET status = 'archived' WHERE status = 'active' AND updated_at < datetime('now', '-7 days')"
    ).run();
    if (archived.changes > 0) {
      logger.info?.(`periodic: archived ${archived.changes} stale conversations`);
    }
  } catch {}

  // 4. Report stats
  const stats = getDbStats(db, dbPath);
  logger.info?.(`periodic stats: ${stats.totalEntries} entries (${JSON.stringify(stats.entryBreakdown)}), ${stats.vectorCount} vectors, ${stats.factsCount} facts, ${stats.dbSizeMB} MB, ${stats.conversationsActive} active convs`);
}
