/**
 * Memory Bank barrel export
 */

export { extractFacts } from "./extractor";
export { consolidateFact } from "./consolidator";
export { DEFAULT_TOPICS } from "./topics";
export type {
  MemoryFact,
  MemoryRevision,
  MemoryTopic,
  ExtractedFact,
  ConsolidationResult,
  MemoryBankConfig,
} from "./types";
