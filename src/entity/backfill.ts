/**
 * entity/backfill.ts — Backfill entity extraction for existing facts + entries
 *
 * Runs on startup (background, non-blocking). Processes facts and entries
 * that haven't been linked to any entities yet.
 *
 * After initial backfill, new data is processed live via on-turn-end hook.
 */

import type { DatabasePort } from "../db/port";
import type { MemoryBankConfig } from "../memory-bank/types";
import { extractAndLinkEntities } from "./extractor";

interface Logger {
  info?(...args: unknown[]): void;
  warn?(...args: unknown[]): void;
}

/**
 * Backfill entities from existing facts that have no entity mentions.
 * Groups facts in batches to avoid overwhelming the LLM extraction endpoint.
 */
export async function backfillEntitiesFromFacts(
  port: DatabasePort,
  config: MemoryBankConfig,
  logger: Logger,
): Promise<{ processed: number; entities: number; relations: number }> {
  // Get facts that have NO entity mentions linked
  const allFacts = await port.queryFacts({ status: "active", limit: 500, minConfidence: 0.0 });
  const mentionedFactIds = await getFactIdsWithMentions(port);
  const unprocessed = allFacts.filter(f => !mentionedFactIds.has(f.id));

  if (unprocessed.length === 0) {
    logger.info?.("entity-backfill: all facts already processed");
    return { processed: 0, entities: 0, relations: 0 };
  }

  logger.info?.(`entity-backfill: ${unprocessed.length} facts without entity links, starting backfill...`);

  const entitiesBefore = await countEntities(port);
  const relationsBefore = await countRelations(port);
  let processed = 0;

  // Process in batches of 5 facts at a time (each fact = 1 LLM call)
  const BATCH_SIZE = 5;
  for (let i = 0; i < unprocessed.length; i += BATCH_SIZE) {
    const batch = unprocessed.slice(i, i + BATCH_SIZE);

    for (const fact of batch) {
      try {
        const text = `[${fact.topic}] ${fact.fact}`;
        await extractAndLinkEntities(text, port, config, logger);
        // Link the entity mentions to this fact
        await linkExtractedToFact(port, fact.id, text);
        processed++;
      } catch (err) {
        logger.warn?.(`entity-backfill: failed on fact #${fact.id}: ${String(err).slice(0, 100)}`);
      }
    }

    // Progress log + yield
    if (processed > 0 && processed % 10 === 0) {
      logger.info?.(`entity-backfill: progress ${processed}/${unprocessed.length} facts`);
    }
    // Rate limit: wait 500ms between batches to avoid overwhelming Gemini
    await new Promise(r => setTimeout(r, 500));
  }

  const entitiesAfter = await countEntities(port);
  const relationsAfter = await countRelations(port);

  const result = {
    processed,
    entities: entitiesAfter - entitiesBefore,
    relations: relationsAfter - relationsBefore,
  };

  logger.info?.(
    `entity-backfill: complete — ${result.processed} facts processed, ` +
    `${result.entities} new entities, ${result.relations} new relations ` +
    `(total: ${entitiesAfter} entities, ${relationsAfter} relations)`
  );

  return result;
}

/**
 * Backfill entities from entries (skill, config, history types).
 * Only processes entries that have content >50 chars and no existing mentions.
 */
export async function backfillEntitiesFromEntries(
  port: DatabasePort,
  config: MemoryBankConfig,
  logger: Logger,
): Promise<{ processed: number; entities: number; relations: number }> {
  // Get entry IDs that already have mentions
  const mentionedEntryIds = await getEntryIdsWithMentions(port);

  // Get entries worth processing (skill, config, history — skip tool/result noise)
  const allEntries: any[] = [];
  for (const entryType of ["skill", "config", "history", "task", "file"] as const) {
    try {
      const results = await port.ftsSearch("", entryType, 100);
      allEntries.push(...results);
    } catch { /* skip */ }
  }
  const unprocessed = allEntries.filter((e: any) =>
    !mentionedEntryIds.has(e.id) &&
    e.content && e.content.length > 50
  );

  if (unprocessed.length === 0) {
    logger.info?.("entity-backfill: all entries already processed");
    return { processed: 0, entities: 0, relations: 0 };
  }

  logger.info?.(`entity-backfill: ${unprocessed.length} entries without entity links, starting backfill...`);

  const entitiesBefore = await countEntities(port);
  const relationsBefore = await countRelations(port);
  let processed = 0;

  const BATCH_SIZE = 5;
  for (let i = 0; i < unprocessed.length; i += BATCH_SIZE) {
    const batch = unprocessed.slice(i, i + BATCH_SIZE);

    for (const entry of batch) {
      try {
        const text = entry.content.slice(0, 500); // Limit to 500 chars for extraction
        await extractAndLinkEntities(text, port, config, logger);
        // Link mentions to this entry
        await linkExtractedToEntry(port, entry.id, text);
        processed++;
      } catch (err) {
        logger.warn?.(`entity-backfill: failed on entry #${entry.id}: ${String(err).slice(0, 100)}`);
      }
    }

    if (processed > 0 && processed % 10 === 0) {
      logger.info?.(`entity-backfill: progress ${processed}/${unprocessed.length} entries`);
    }
    await new Promise(r => setTimeout(r, 500));
  }

  const entitiesAfter = await countEntities(port);
  const relationsAfter = await countRelations(port);

  const result = {
    processed,
    entities: entitiesAfter - entitiesBefore,
    relations: relationsAfter - relationsBefore,
  };

  logger.info?.(
    `entity-backfill: entries complete — ${result.processed} entries processed, ` +
    `${result.entities} new entities, ${result.relations} new relations`
  );

  return result;
}

// ============================================================================
// Helpers — delegates to DatabasePort methods (no direct pool access)
// ============================================================================

async function getFactIdsWithMentions(port: DatabasePort): Promise<Set<number>> {
  return port.getFactIdsWithEntityMentions();
}

async function getEntryIdsWithMentions(port: DatabasePort): Promise<Set<number>> {
  return port.getEntryIdsWithEntityMentions();
}

async function countEntities(port: DatabasePort): Promise<number> {
  return port.countEntities();
}

async function countRelations(port: DatabasePort): Promise<number> {
  return port.countRelations();
}

async function linkExtractedToFact(port: DatabasePort, factId: number, _text: string): Promise<void> {
  await port.linkRecentMentionsToFact(factId, 30);
}

async function linkExtractedToEntry(port: DatabasePort, entryId: number, _text: string): Promise<void> {
  await port.linkRecentMentionsToEntry(entryId, 30);
}
