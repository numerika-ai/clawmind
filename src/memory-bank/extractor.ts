/**
 * Memory Bank fact extractor — calls Ollama (Spark) to extract facts from conversations
 */

import type { MemoryBankConfig, ExtractedFact } from "./types";
import { DEFAULT_TOPICS } from "./topics";

const VALID_TOPICS = new Set(DEFAULT_TOPICS.map(t => t.name));

const EXTRACTION_PROMPT = `You are a memory extraction system. Analyze the conversation below and extract key facts worth remembering long-term.

For each fact, output a JSON array of objects with these fields:
- "fact": A concise, standalone statement (one sentence)
- "topic": One of: user_preferences, technical_facts, project_context, instructions, people_orgs, decisions, learned_patterns
- "confidence": 0.0-1.0 how confident you are this is a real, stable fact

Rules:
- Only extract facts that would be useful in future conversations
- Skip ephemeral details (timestamps, transient errors, greetings)
- Each fact must be self-contained and understandable without context
- Prefer fewer high-quality facts over many low-quality ones
- Output ONLY a JSON array, no other text

Conversation:
`;

export async function extractFacts(
  conversationText: string,
  config: MemoryBankConfig,
): Promise<ExtractedFact[]> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);

    const resp = await fetch(config.extractionUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: config.extractionModel,
        messages: [
          {
            role: "user",
            content: EXTRACTION_PROMPT + conversationText.slice(0, 4000),
          },
        ],
        temperature: 0.3,
        max_tokens: 2000,
      }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!resp.ok) return [];

    const data = (await resp.json()) as any;
    const content = data?.choices?.[0]?.message?.content ?? "";

    // Extract JSON array from response (may have markdown fences)
    const jsonMatch = content.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return [];

    const parsed = JSON.parse(jsonMatch[0]) as unknown[];
    if (!Array.isArray(parsed)) return [];

    const facts: ExtractedFact[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== "object") continue;
      const obj = item as Record<string, unknown>;

      const fact = typeof obj.fact === "string" ? obj.fact.trim() : "";
      let topic = typeof obj.topic === "string" ? obj.topic.trim() : "learned_patterns";
      const confidence = typeof obj.confidence === "number" ? Math.min(1, Math.max(0, obj.confidence)) : 0.5;

      if (!fact || fact.length < 10) continue;

      // Validate topic, fallback to learned_patterns
      if (!VALID_TOPICS.has(topic)) topic = "learned_patterns";

      facts.push({ fact, topic, confidence });

      if (facts.length >= config.maxFactsPerTurn) break;
    }

    return facts;
  } catch {
    // Ollama unreachable or parse error — graceful fallback
    return [];
  }
}
