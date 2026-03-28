/**
 * tools/unified-reflect.ts — Synthesize and reason across stored memories (v2.0)
 *
 * Runs multi-strategy retrieval + entity graph + LLM synthesis.
 */

import { Type } from "@sinclair/typebox";
import type { ToolDef, ToolResult } from "../types";
import type { DatabasePort } from "../db/port";
import { embed } from "../embedding/nemotron";

interface VectorSearcher {
  isReady(): boolean;
  search(query: string, topK?: number, excludeTypes?: string[]): Promise<Array<{ entryId: number; distance: number }>>;
}

const EXTRACTION_URL = process.env.EXTRACTION_URL ?? "http://192.168.1.80:11434/v1/chat/completions";
const EXTRACTION_MODEL = process.env.EXTRACTION_MODEL ?? "qwen3:32b";
const EXTRACTION_API_KEY = process.env.EXTRACTION_API_KEY;

export function createUnifiedReflectTool(port: DatabasePort, vectorManager: VectorSearcher | null): ToolDef {
  return {
    name: "unified_reflect",
    label: "Memory Reflect",
    description: "Synthesize and reason across stored memories to answer a complex question. Combines fact search, entity graph, and LLM reasoning.",
    parameters: Type.Object({
      query: Type.String({ description: "The question to reflect on" }),
      scope: Type.Optional(Type.String({ description: "Agent scope (default: global)" })),
    }),
    async execute(_id, params): Promise<ToolResult> {
      const query = params.query as string;
      const scope = (params.scope as string) ?? "global";

      try {
        // 1. Gather facts via vector search
        const factLines: string[] = [];
        const queryEmb = await embed(query, "query");
        if (queryEmb) {
          const vecFacts = await port.searchFactsByVector(queryEmb, 15, scope);
          for (const f of vecFacts) {
            const sim = 1 - f.distance;
            if (sim > 0.3) {
              factLines.push(`- [${f.topic}] ${f.fact} (${(f.confidence * 100).toFixed(0)}% confidence)`);
              try { await port.updateFactAccessCount(f.factId); } catch {}
            }
          }
        }

        // Text search fallback
        const textFacts = await port.queryFacts({ status: "active", textSearch: query, scope, limit: 10 });
        const seenIds = new Set(factLines.map(l => l)); // dedup by content
        for (const f of textFacts) {
          const line = `- [${f.topic}] ${f.fact} (${(f.confidence * 100).toFixed(0)}% confidence)`;
          if (!seenIds.has(line)) {
            factLines.push(line);
            seenIds.add(line);
          }
        }

        // 2. Gather entries via vector search
        const entryLines: string[] = [];
        if (vectorManager?.isReady()) {
          try {
            const vecEntries = await vectorManager.search(query, 10, ["tool"]);
            if (vecEntries.length > 0) {
              const entries = await port.queryEntries({ ids: vecEntries.map(r => r.entryId) });
              for (const e of entries) {
                entryLines.push(`- [${e.entry_type}] ${(e.summary || e.content?.slice(0, 120) || "")}`);
              }
            }
          } catch {}
        }

        // 3. Gather entities and relations
        const graphLines: string[] = [];
        try {
          const entities = await port.searchEntities(query, 5);
          for (const e of entities) {
            const rels = await port.getEntityRelations(e.id);
            if (rels.length > 0) {
              for (const r of rels.slice(0, 5)) {
                graphLines.push(`- ${r.source_name} →[${r.relation_type}]→ ${r.target_name}`);
              }
            } else {
              graphLines.push(`- ${e.name} (${e.entity_type})`);
            }
          }
        } catch {}

        // 4. Build synthesis prompt
        const contextParts: string[] = [];
        if (factLines.length > 0) contextParts.push(`## Memories\n${factLines.join("\n")}`);
        if (graphLines.length > 0) contextParts.push(`## Knowledge Graph\n${graphLines.join("\n")}`);
        if (entryLines.length > 0) contextParts.push(`## Additional Context\n${entryLines.join("\n")}`);

        if (contextParts.length === 0) {
          return { content: [{ type: "text", text: `No relevant memories found for: "${query}"` }] };
        }

        const synthPrompt = `Based on the following memories and knowledge graph, synthesize a comprehensive answer to the user's question.

${contextParts.join("\n\n")}

## Question
${query}

Provide a thorough synthesis. If memories are contradictory, note the conflict. If information is uncertain (low confidence), mention that. Be concise but complete.`;

        // 5. Call LLM for synthesis
        const synthesis = await callLLM(synthPrompt);

        if (!synthesis) {
          // Fallback: return raw context without synthesis
          return {
            content: [{ type: "text", text: `## Reflect: ${query}\n\n${contextParts.join("\n\n")}\n\n*(LLM synthesis unavailable — raw context above)*` }],
            details: { facts: factLines.length, entities: graphLines.length, entries: entryLines.length, synthesized: false },
          };
        }

        return {
          content: [{ type: "text", text: `## Reflect: ${query}\n\n${synthesis}\n\n---\n*Based on ${factLines.length} facts, ${graphLines.length} graph relations, ${entryLines.length} entries*` }],
          details: { facts: factLines.length, entities: graphLines.length, entries: entryLines.length, synthesized: true },
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Reflection failed: ${String(err).slice(0, 200)}` }],
        };
      }
    },
  };
}

async function callLLM(prompt: string): Promise<string | null> {
  try {
    const isAnthropic = EXTRACTION_URL.includes("anthropic.com");
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (EXTRACTION_API_KEY) {
      if (isAnthropic) {
        headers["x-api-key"] = EXTRACTION_API_KEY;
        headers["anthropic-version"] = "2023-06-01";
      } else {
        headers["Authorization"] = `Bearer ${EXTRACTION_API_KEY}`;
      }
    }

    const resp = await fetch(EXTRACTION_URL, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: EXTRACTION_MODEL,
        messages: [{ role: "user", content: prompt }],
        temperature: 0.3,
        max_tokens: 2000,
      }),
      signal: AbortSignal.timeout(45000),
    });

    if (!resp.ok) return null;
    const data = (await resp.json()) as any;
    return isAnthropic
      ? (data?.content?.[0]?.text ?? null)
      : (data?.choices?.[0]?.message?.content ?? null);
  } catch {
    return null;
  }
}
