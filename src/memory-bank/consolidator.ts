/**
 * Memory Bank consolidator — deduplicates and merges facts using semantic similarity
 */

import type { Database } from "better-sqlite3";
import { qwenEmbed, cosineSim } from "../embedding/ollama";
import type { ExtractedFact, ConsolidationResult, MemoryBankConfig, MemoryFact } from "./types";

interface NativeLanceManager {
  isReady(): boolean;
  addEntry(entryId: number, text: string): Promise<boolean>;
}

export async function consolidateFact(
  newFact: ExtractedFact,
  db: Database,
  config: MemoryBankConfig,
  lanceManager: NativeLanceManager | null,
  logger: { info?(...args: unknown[]): void; warn?(...args: unknown[]): void },
): Promise<ConsolidationResult> {
  // Embed the new fact
  const newEmb = await qwenEmbed(newFact.fact);

  // If embedding fails, just create a new fact without vector dedup
  if (!newEmb) {
    const factId = insertFact(db, newFact);
    logRevision(db, factId, "created", null, newFact.fact, "embedding unavailable");
    return { action: "created", factId, similarity: 0 };
  }

  // Find existing facts in same topic that are not expired
  const existing = db.prepare(
    "SELECT id, fact, confidence, hnsw_key FROM memory_facts WHERE topic = ? AND expired_at IS NULL ORDER BY confidence DESC LIMIT 50"
  ).all(newFact.topic) as Array<Pick<MemoryFact, "id" | "fact" | "confidence" | "hnsw_key">>;

  let bestSim = 0;
  let bestMatch: (typeof existing)[0] | null = null;

  for (const ex of existing) {
    const exEmb = await qwenEmbed(ex.fact);
    if (!exEmb) continue;
    const sim = cosineSim(newEmb, exEmb);
    if (sim > bestSim) {
      bestSim = sim;
      bestMatch = ex;
    }
  }

  // Consolidation logic
  if (bestMatch && bestSim > 0.95) {
    // Near-duplicate: boost confidence
    const newConf = Math.min(1.0, bestMatch.confidence + 0.05);
    db.prepare("UPDATE memory_facts SET confidence = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
      .run(newConf, bestMatch.id);
    logRevision(db, bestMatch.id, "merged", bestMatch.fact, bestMatch.fact, `confidence boost ${bestMatch.confidence.toFixed(2)} -> ${newConf.toFixed(2)} (sim=${bestSim.toFixed(3)})`);
    logger.info?.(`memory-bank: BOOST fact #${bestMatch.id} (sim=${bestSim.toFixed(3)}, conf=${newConf.toFixed(2)})`);
    return { action: "boosted", factId: bestMatch.id, similarity: bestSim };
  }

  if (bestMatch && bestSim >= 0.90) {
    // Similar: update content
    const oldContent = bestMatch.fact;
    db.prepare("UPDATE memory_facts SET fact = ?, confidence = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
      .run(newFact.fact, Math.max(bestMatch.confidence, newFact.confidence), bestMatch.id);
    logRevision(db, bestMatch.id, "updated", oldContent, newFact.fact, `content update (sim=${bestSim.toFixed(3)})`);
    logger.info?.(`memory-bank: UPDATE fact #${bestMatch.id} (sim=${bestSim.toFixed(3)})`);
    return { action: "updated", factId: bestMatch.id, similarity: bestSim };
  }

  // Below 0.90: create new fact
  const factId = insertFact(db, newFact);
  logRevision(db, factId, "created", null, newFact.fact, bestSim > 0 ? `new (best sim=${bestSim.toFixed(3)})` : "new (no similar facts)");

  // Embed in LanceDB (fire and forget)
  if (lanceManager?.isReady()) {
    lanceManager.addEntry(factId, newFact.fact).catch(() => {});
  }

  logger.info?.(`memory-bank: CREATE fact #${factId} topic=${newFact.topic} conf=${newFact.confidence.toFixed(2)}`);
  return { action: "created", factId, similarity: bestSim };
}

function insertFact(db: Database, fact: ExtractedFact): number {
  const hnswKey = `memfact:${fact.topic}:${Date.now()}`;
  const result = db.prepare(`
    INSERT INTO memory_facts (topic, fact, confidence, source_type, hnsw_key)
    VALUES (?, ?, ?, 'conversation', ?)
  `).run(fact.topic, fact.fact, fact.confidence, hnswKey);
  return result.lastInsertRowid as number;
}

function logRevision(
  db: Database,
  factId: number,
  revisionType: string,
  oldContent: string | null,
  newContent: string | null,
  reason: string,
): void {
  try {
    db.prepare(`
      INSERT INTO memory_revisions (fact_id, revision_type, old_content, new_content, reason)
      VALUES (?, ?, ?, ?, ?)
    `).run(factId, revisionType, oldContent, newContent, reason);
  } catch {
    // Non-critical — don't break consolidation
  }
}
