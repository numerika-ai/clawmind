/**
 * Memory Bank management tool — list, search, add, edit, delete, status
 *
 * Now uses DatabasePort (async) for backend-agnostic DB access.
 */

import { Type } from "@sinclair/typebox";
import type { ToolDef, ToolResult } from "../types";
import type { DatabasePort } from "../db/port";
import { qwenEmbed, cosineSim } from "../embedding/nemotron";

export function createMemoryBankManageTool(port: DatabasePort): ToolDef {
  return {
    name: "memory_bank_manage",
    label: "Memory Bank Manager",
    description: "Manage long-term memory facts: list, search, add, edit, delete facts, or view stats.",
    parameters: Type.Object({
      action: Type.String({ description: "Action: list | search | add | edit | delete | status" }),
      topic: Type.Optional(Type.String({ description: "Filter by topic (for list/add)" })),
      status: Type.Optional(Type.String({ description: "Filter by status: active | stale | contradicted | archived (for list)" })),
      query: Type.Optional(Type.String({ description: "Search query (for search action)" })),
      fact_id: Type.Optional(Type.Number({ description: "Fact ID (for edit/delete)" })),
      fact: Type.Optional(Type.String({ description: "Fact content (for add/edit)" })),
      confidence: Type.Optional(Type.Number({ description: "Confidence 0.0-1.0 (for add/edit)" })),
      scope: Type.Optional(Type.String({ description: "Scope: global or agent_id (for add)" })),
      limit: Type.Optional(Type.Number({ description: "Max results (default: 20)" })),
    }),
    async execute(_id, params): Promise<ToolResult> {
      const action = params.action as string;
      const limit = (params.limit as number) ?? 20;

      switch (action) {
        case "list":
          return listFacts(port, params, limit);
        case "search":
          return searchFacts(port, params, limit);
        case "add":
          return addFact(port, params);
        case "edit":
          return editFact(port, params);
        case "delete":
          return deleteFact(port, params);
        case "status":
          return getStatus(port);
        default:
          return { content: [{ type: "text", text: `Unknown action: ${action}. Use: list, search, add, edit, delete, status` }] };
      }
    },
  };
}

async function listFacts(port: DatabasePort, params: Record<string, unknown>, limit: number): Promise<ToolResult> {
  const topic = params.topic as string | undefined;
  const status = (params.status as string) ?? "active";

  const facts = await port.queryFacts({
    topic: topic ?? undefined,
    status,
    limit,
  });

  if (facts.length === 0) {
    return { content: [{ type: "text", text: `No facts found (status=${status}${topic ? `, topic=${topic}` : ""})` }] };
  }

  const lines = facts.map((f: any) =>
    `#${f.id} [${f.topic}] (${(f.confidence * 100).toFixed(0)}%, ${f.status}, scope=${f.scope}) ${f.fact}`
  );

  return {
    content: [{ type: "text", text: `## Memory Facts (${facts.length} results)\n${lines.join("\n")}` }],
    details: { count: facts.length },
  };
}

async function searchFacts(port: DatabasePort, params: Record<string, unknown>, limit: number): Promise<ToolResult> {
  const query = params.query as string;
  if (!query) {
    return { content: [{ type: "text", text: "Error: query parameter required for search" }] };
  }

  const queryEmb = await qwenEmbed(query);

  if (!queryEmb) {
    // Fallback to text search if embedding unavailable
    const likeFacts = await port.queryFacts({
      status: "active",
      textSearch: query,
      limit,
    });

    const lines = likeFacts.map((f: any) =>
      `#${f.id} [${f.topic}] (${(f.confidence * 100).toFixed(0)}%) ${f.fact}`
    );
    return {
      content: [{ type: "text", text: `## Text Search Results (${likeFacts.length})\n${lines.join("\n")}` }],
      details: { count: likeFacts.length, method: "text" },
    };
  }

  // Vector-first: single KNN query
  try {
    const vecResults = await port.searchFactsByVector(queryEmb, limit);
    const topFacts = vecResults
      .map(r => ({ ...r, similarity: 1 - r.distance }))
      .filter(r => r.similarity > 0.3);

    if (topFacts.length > 0) {
      const lines = topFacts.map(f =>
        `#${f.factId} [${f.topic}] (${(f.similarity * 100).toFixed(0)}% sim, ${(f.confidence * 100).toFixed(0)}% conf) ${f.fact}`
      );

      return {
        content: [{ type: "text", text: `## Semantic Search Results (${topFacts.length})\n${lines.join("\n")}` }],
        details: { count: topFacts.length, method: "semantic-vec" },
      };
    }
  } catch {
    // Vector search unavailable — fall through to O(n) fallback
  }

  // Fallback: O(n) per-fact embedding
  const activeFacts = await port.queryFacts({ status: "active", limit: 100 });

  const scored: Array<{ id: number; topic: string; fact: string; confidence: number; scope: string; similarity: number }> = [];
  for (const f of activeFacts) {
    const fEmb = await qwenEmbed(f.fact);
    if (!fEmb) continue;
    const sim = cosineSim(queryEmb, fEmb);
    if (sim > 0.3) {
      scored.push({ ...f, scope: f.scope ?? "global", similarity: sim });
    }
  }

  scored.sort((a, b) => b.similarity - a.similarity);
  const topFacts = scored.slice(0, limit);

  const lines = topFacts.map(f =>
    `#${f.id} [${f.topic}] (${(f.similarity * 100).toFixed(0)}% sim, ${(f.confidence * 100).toFixed(0)}% conf, scope=${f.scope}) ${f.fact}`
  );

  return {
    content: [{ type: "text", text: `## Semantic Search Results (${topFacts.length})\n${lines.join("\n")}` }],
    details: { count: topFacts.length, method: "semantic" },
  };
}

async function addFact(port: DatabasePort, params: Record<string, unknown>): Promise<ToolResult> {
  const fact = params.fact as string;
  const topic = (params.topic as string) ?? "learned_patterns";
  const confidence = (params.confidence as number) ?? 0.8;
  const scope = (params.scope as string) ?? "global";

  if (!fact || fact.length < 5) {
    return { content: [{ type: "text", text: "Error: fact parameter required (min 5 chars)" }] };
  }

  const hnswKey = `memfact:${topic}:${Date.now()}`;
  const factId = await port.storeFact({
    topic,
    fact,
    confidence: Math.min(1, Math.max(0, confidence)),
    sourceType: "manual",
    scope,
    hnswKey,
  });

  await port.storeRevision(factId, "created", null, fact, "manual add");

  return {
    content: [{ type: "text", text: `Created fact #${factId} [${topic}] (conf=${confidence}, scope=${scope})` }],
    details: { factId },
  };
}

async function editFact(port: DatabasePort, params: Record<string, unknown>): Promise<ToolResult> {
  const factId = params.fact_id as number;
  const newFact = params.fact as string;
  const newConf = params.confidence as number | undefined;

  if (!factId) {
    return { content: [{ type: "text", text: "Error: fact_id parameter required" }] };
  }
  if (!newFact) {
    return { content: [{ type: "text", text: "Error: fact parameter required for edit" }] };
  }

  const existing = await port.queryFacts({ id: factId });
  if (existing.length === 0) {
    return { content: [{ type: "text", text: `Error: fact #${factId} not found` }] };
  }

  const conf = newConf !== undefined ? Math.min(1, Math.max(0, newConf)) : existing[0].confidence;
  await port.updateFact(factId, { fact: newFact, confidence: conf });
  await port.storeRevision(factId, "manual_edit", existing[0].fact, newFact, "manual edit");

  return {
    content: [{ type: "text", text: `Updated fact #${factId}: "${newFact}" (conf=${conf.toFixed(2)})` }],
    details: { factId },
  };
}

async function deleteFact(port: DatabasePort, params: Record<string, unknown>): Promise<ToolResult> {
  const factId = params.fact_id as number;
  if (!factId) {
    return { content: [{ type: "text", text: "Error: fact_id parameter required" }] };
  }

  const existing = await port.queryFacts({ id: factId });
  if (existing.length === 0) {
    return { content: [{ type: "text", text: `Error: fact #${factId} not found` }] };
  }

  // Soft delete: set status to archived
  await port.updateFact(factId, { status: "archived" });
  await port.storeRevision(factId, "deleted", existing[0].fact, null, "manual delete (soft)");

  return {
    content: [{ type: "text", text: `Archived fact #${factId} (soft delete)` }],
    details: { factId },
  };
}

async function getStatus(port: DatabasePort): Promise<ToolResult> {
  const stats = await port.getFactStats();

  const lines = [
    `## Memory Bank Status`,
    `Total facts: ${stats.total} (active: ${stats.active}, contradicted: ${stats.contradicted}, archived: ${stats.archived}, stale: ${stats.stale})`,
    `Total revisions: ${stats.revisionCount}`,
    `Last extraction: ${stats.lastExtraction ?? "never"}`,
    ``,
    `### By Topic`,
    ...stats.byTopic.map(t => `- ${t.topic}: ${t.count} facts (avg conf: ${(t.avg_conf * 100).toFixed(0)}%)`),
  ];

  return {
    content: [{ type: "text", text: lines.join("\n") }],
    details: { total: stats.total, active: stats.active, contradicted: stats.contradicted, archived: stats.archived, stale: stats.stale, revisionCount: stats.revisionCount },
  };
}
