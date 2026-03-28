/**
 * entity/extractor.ts — Entity extraction + resolution + linking (v2.0)
 *
 * Extracts entities (people, orgs, projects, tools, concepts) and relations
 * from conversation text via LLM, then resolves against existing entities.
 */

import type { DatabasePort } from "../db/port";
import type { MemoryBankConfig } from "../memory-bank/types";
import { embed, cosineSim } from "../embedding/nemotron";

export interface ExtractedEntity {
  name: string;
  entityType: string;
  aliases: string[];
  metadata: Record<string, unknown>;
}

export interface ExtractedRelation {
  sourceName: string;
  targetName: string;
  relationType: string;
  confidence: number;
}

interface Logger {
  info?(...args: unknown[]): void;
  warn?(...args: unknown[]): void;
}

/**
 * Extract entities from text using LLM.
 */
export async function extractEntities(
  text: string,
  config: MemoryBankConfig,
): Promise<ExtractedEntity[]> {
  const PROMPT = `Extract all named entities from this conversation. For each entity, output:
- "name": canonical name
- "entity_type": one of person, org, project, tool, concept
- "aliases": any alternative names mentioned
- "metadata": any relevant attributes

Output ONLY a JSON array. If no entities found, output [].

Conversation:
${text.slice(0, 4000)}`;

  try {
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
        messages: [{ role: "user", content: PROMPT }],
        temperature: 0.2,
        max_tokens: 1500,
      }),
      signal: AbortSignal.timeout(30000),
    });

    if (!resp.ok) return [];
    const data = (await resp.json()) as any;
    const content = isAnthropic
      ? (data?.content?.[0]?.text ?? "")
      : (data?.choices?.[0]?.message?.content ?? "");

    const jsonMatch = content.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return [];

    const parsed = JSON.parse(jsonMatch[0]) as unknown[];
    if (!Array.isArray(parsed)) return [];

    return parsed
      .filter((item): item is Record<string, unknown> => item != null && typeof item === "object")
      .map(obj => ({
        name: String(obj.name ?? "").trim(),
        entityType: String(obj.entity_type ?? "concept"),
        aliases: Array.isArray(obj.aliases) ? (obj.aliases as string[]).filter(a => typeof a === "string") : [],
        metadata: typeof obj.metadata === "object" && obj.metadata ? (obj.metadata as Record<string, unknown>) : {},
      }))
      .filter(e => e.name.length >= 2)
      .slice(0, 10);
  } catch {
    return [];
  }
}

/**
 * Extract relations between entities using LLM.
 */
export async function extractRelations(
  text: string,
  entities: ExtractedEntity[],
  config: MemoryBankConfig,
): Promise<ExtractedRelation[]> {
  if (entities.length < 2) return [];

  const entityNames = entities.map(e => e.name).join(", ");
  const PROMPT = `Given these entities: [${entityNames}], extract relationships between them from this conversation.
For each relation:
- "source_name": entity name
- "target_name": entity name
- "relation_type": one of works_on, uses, owns, depends_on, related_to, manages, created_by
- "confidence": 0.0-1.0

Output ONLY a JSON array.

Conversation:
${text.slice(0, 4000)}`;

  try {
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
        messages: [{ role: "user", content: PROMPT }],
        temperature: 0.2,
        max_tokens: 1000,
      }),
      signal: AbortSignal.timeout(30000),
    });

    if (!resp.ok) return [];
    const data = (await resp.json()) as any;
    const content = isAnthropic
      ? (data?.content?.[0]?.text ?? "")
      : (data?.choices?.[0]?.message?.content ?? "");

    const jsonMatch = content.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return [];

    const parsed = JSON.parse(jsonMatch[0]) as unknown[];
    if (!Array.isArray(parsed)) return [];

    return parsed
      .filter((item): item is Record<string, unknown> => item != null && typeof item === "object")
      .map(obj => ({
        sourceName: String(obj.source_name ?? "").trim(),
        targetName: String(obj.target_name ?? "").trim(),
        relationType: String(obj.relation_type ?? "related_to"),
        confidence: typeof obj.confidence === "number" ? Math.min(1, Math.max(0, obj.confidence)) : 0.7,
      }))
      .filter(r => r.sourceName.length >= 2 && r.targetName.length >= 2)
      .slice(0, 15);
  } catch {
    return [];
  }
}

/**
 * Resolve an entity name against existing entities in the database.
 * Returns the entity ID if found, null if new.
 */
export async function resolveEntityAlias(
  name: string,
  port: DatabasePort,
): Promise<number | null> {
  // 1. Exact/fuzzy name match via DB
  const existing = await port.getEntityByName(name);
  if (existing) return Number(existing.id);

  // 2. Embedding similarity match (if available)
  try {
    const nameEmb = await embed(name, "passage");
    if (nameEmb) {
      const similar = await port.searchEntitiesByEmbedding(nameEmb, 3);
      for (const s of similar) {
        const sim = 1 - (s.distance ?? 1);
        if (sim > 0.85) return Number(s.id);
      }
    }
  } catch {}

  return null;
}

/**
 * Full pipeline: extract entities + relations from text, resolve against DB, store.
 */
export async function extractAndLinkEntities(
  text: string,
  port: DatabasePort,
  config: MemoryBankConfig,
  logger: Logger,
): Promise<void> {
  // Extract entities
  const extracted = await extractEntities(text, config);
  if (extracted.length === 0) return;

  // Resolve or create entities
  const entityIdMap = new Map<string, number>();

  for (const entity of extracted) {
    const existingId = await resolveEntityAlias(entity.name, port);
    if (existingId) {
      entityIdMap.set(entity.name, existingId);
    } else {
      const newId = await port.storeEntity({
        name: entity.name,
        entityType: entity.entityType,
        aliases: entity.aliases,
        metadata: entity.metadata,
      });
      entityIdMap.set(entity.name, newId);
    }
  }

  // Extract and store relations
  const relations = await extractRelations(text, extracted, config);
  for (const rel of relations) {
    const sourceId = entityIdMap.get(rel.sourceName);
    const targetId = entityIdMap.get(rel.targetName);
    if (sourceId && targetId && sourceId !== targetId) {
      await port.storeEntityRelation({
        sourceEntityId: sourceId,
        targetEntityId: targetId,
        relationType: rel.relationType,
        confidence: rel.confidence,
      });
    }
  }

  // Store mentions (link entities to the conversation context)
  const snippet = text.slice(0, 200);
  for (const [_name, entityId] of entityIdMap) {
    await port.storeEntityMention(entityId, undefined, undefined, snippet);
  }

  if (extracted.length > 0) {
    logger.info?.(`entity-extraction: stored ${extracted.length} entities, ${relations.length} relations`);
  }
}
