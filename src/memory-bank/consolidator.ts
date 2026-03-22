/**
 * Memory Bank consolidator — deduplicates, merges, and detects contradictions
 * using semantic similarity + LLM verification.
 *
 * Now uses DatabasePort (async) for backend-agnostic DB access.
 */

import { embed, cosineSim } from "../embedding/nemotron";
import type { DatabasePort } from "../db/port";
import type { ExtractedFact, ConsolidationResult, MemoryBankConfig } from "./types";

/**
 * Ask the extraction LLM whether two facts contradict each other.
 * Returns true if they contradict, false otherwise.
 */
async function checkContradiction(
  factA: string,
  factB: string,
  config: MemoryBankConfig,
): Promise<{ contradicts: boolean; reason: string }> {
  try {
    const prompt = `Do these two facts contradict each other? Answer YES or NO with a brief reason.

Fact A: ${factA}
Fact B: ${factB}

Answer:`;

    const isAnthropic = config.extractionUrl.includes("anthropic.com");
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (config.extractionApiKey) {
      if (isAnthropic) {
        headers["x-api-key"] = config.extractionApiKey;
        headers["anthropic-version"] = "2023-06-01";
      } else {
        headers["Authorization"] = `Bearer ${config.extractionApiKey}`;
      }
    }

    const resp = await fetch(config.extractionUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: config.extractionModel,
        messages: [{ role: "user", content: prompt }],
        temperature: 0.1,
        max_tokens: 200,
      }),
      signal: AbortSignal.timeout(15000),
    });

    if (!resp.ok) return { contradicts: false, reason: "LLM unavailable" };

    const data = (await resp.json()) as any;
    const content = isAnthropic
      ? (data?.content?.[0]?.text ?? "")
      : (data?.choices?.[0]?.message?.content ?? "");

    const answer = content.trim().toUpperCase();
    const contradicts = answer.startsWith("YES");
    return { contradicts, reason: content.trim().slice(0, 200) };
  } catch {
    return { contradicts: false, reason: "contradiction check failed" };
  }
}

export async function consolidateFact(
  newFact: ExtractedFact,
  port: DatabasePort,
  config: MemoryBankConfig,
  _unused: unknown,
  logger: { info?(...args: unknown[]): void; warn?(...args: unknown[]): void },
  scope?: string,
): Promise<ConsolidationResult> {
  // Embed the new fact using Qwen3
  const newEmb = await embed(newFact.fact, "passage");

  // Helper to store embedding via port
  const storeVec = async (factId: number, emb: number[]) => {
    try { await port.storeFactEmbedding(factId, emb); } catch {}
  };

  // If embedding fails, just create a new fact without vector dedup
  if (!newEmb) {
    const factId = await insertFact(port, newFact, scope);
    await logRevision(port, factId, "created", null, newFact.fact, "embedding unavailable");
    return { action: "created", factId, similarity: 0 };
  }

  // Vector-first: use pre-embedded facts via port
  let bestSim = 0;
  let bestMatch: { id: number; fact: string; confidence: number; hnsw_key?: string } | null = null;

  try {
    const vecResults = await port.searchFactsByVector(newEmb, 5, scope);
    for (const vr of vecResults) {
      if (vr.topic !== newFact.topic) continue;
      const sim = 1 - vr.distance;
      if (sim > bestSim) {
        bestSim = sim;
        const rows = await port.queryFacts({ id: vr.factId });
        if (rows[0]) bestMatch = rows[0];
      }
    }
  } catch {
    // Vector search unavailable — fallback to O(n) per-fact embedding
    const existing = await port.queryFacts({ topic: newFact.topic, status: "active", limit: 50 });
    for (const ex of existing) {
      const exEmb = await embed(ex.fact, "passage");
      if (!exEmb) continue;
      const sim = cosineSim(newEmb, exEmb);
      if (sim > bestSim) {
        bestSim = sim;
        bestMatch = ex;
      }
    }
  }

  // Consolidation logic
  if (bestMatch && bestSim > 0.95) {
    // Near-duplicate: boost confidence
    const newConf = Math.min(1.0, bestMatch.confidence + 0.05);
    await port.updateFact(bestMatch.id, { confidence: newConf });
    await logRevision(port, bestMatch.id, "merged", bestMatch.fact, bestMatch.fact, `confidence boost ${bestMatch.confidence.toFixed(2)} -> ${newConf.toFixed(2)} (sim=${bestSim.toFixed(3)})`);
    logger.info?.(`memory-bank: BOOST fact #${bestMatch.id} (sim=${bestSim.toFixed(3)}, conf=${newConf.toFixed(2)})`);
    return { action: "boosted", factId: bestMatch.id, similarity: bestSim };
  }

  if (bestMatch && bestSim >= 0.90) {
    // Similar: update content
    const oldContent = bestMatch.fact;
    await port.updateFact(bestMatch.id, { fact: newFact.fact, confidence: Math.max(bestMatch.confidence, newFact.confidence) });
    await logRevision(port, bestMatch.id, "updated", oldContent, newFact.fact, `content update (sim=${bestSim.toFixed(3)})`);
    await storeVec(bestMatch.id, newEmb);
    logger.info?.(`memory-bank: UPDATE fact #${bestMatch.id} (sim=${bestSim.toFixed(3)})`);
    return { action: "updated", factId: bestMatch.id, similarity: bestSim };
  }

  // Contradiction detection zone: 0.70 - 0.90 similarity
  if (bestMatch && bestSim >= 0.70 && bestSim < 0.90) {
    const { contradicts, reason } = await checkContradiction(bestMatch.fact, newFact.fact, config);

    if (contradicts) {
      await port.updateFact(bestMatch.id, { status: "contradicted" });
      await logRevision(port, bestMatch.id, "contradicted", bestMatch.fact, newFact.fact, `contradicted by new fact (sim=${bestSim.toFixed(3)}): ${reason}`);

      const factId = await insertFact(port, newFact, scope);
      await logRevision(port, factId, "created", null, newFact.fact, `replaces contradicted fact #${bestMatch.id} (sim=${bestSim.toFixed(3)})`);
      await storeVec(factId, newEmb);

      logger.info?.(`memory-bank: CONTRADICTED fact #${bestMatch.id} → new fact #${factId} (sim=${bestSim.toFixed(3)})`);
      return { action: "contradicted", factId, similarity: bestSim };
    }
  }

  // Below threshold or no contradiction: create new fact
  const factId = await insertFact(port, newFact, scope);
  await logRevision(port, factId, "created", null, newFact.fact, bestSim > 0 ? `new (best sim=${bestSim.toFixed(3)})` : "new (no similar facts)");
  await storeVec(factId, newEmb);

  logger.info?.(`memory-bank: CREATE fact #${factId} topic=${newFact.topic} conf=${newFact.confidence.toFixed(2)}`);
  return { action: "created", factId, similarity: bestSim };
}

async function insertFact(port: DatabasePort, fact: ExtractedFact, scope?: string): Promise<number> {
  const hnswKey = `memfact:${fact.topic}:${Date.now()}`;
  return port.storeFact({
    topic: fact.topic,
    fact: fact.fact,
    confidence: fact.confidence,
    sourceType: "conversation",
    temporalType: fact.temporal_type ?? "current_state",
    scope: scope ?? "global",
    hnswKey,
  });
}

async function logRevision(
  port: DatabasePort,
  factId: number,
  revisionType: string,
  oldContent: string | null,
  newContent: string | null,
  reason: string,
): Promise<void> {
  try {
    await port.storeRevision(factId, revisionType, oldContent, newContent, reason);
  } catch {
    // Non-critical — don't break consolidation
  }
}
