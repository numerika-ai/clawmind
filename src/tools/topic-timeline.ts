/**
 * Topic Timeline tool — trends, timeline, register
 *
 * Temporal tracking of topics across all memory types.
 * Uses DatabasePort (async) for backend-agnostic DB access.
 */

import { Type } from "@sinclair/typebox";
import type { ToolDef, ToolResult } from "../types";
import type { DatabasePort } from "../db/port";

export function createTopicTimelineTool(port: DatabasePort): ToolDef {
  return {
    name: "topic_timeline",
    label: "Topic Timeline",
    description:
      "Track topic activity over time. Actions: trends (what's hot), timeline (chronological events for a topic), register (add a new topic with aliases).",
    parameters: Type.Object({
      action: Type.String({ description: "Action: trends | timeline | register" }),
      slug: Type.Optional(Type.String({ description: "Topic slug (required for 'timeline' and 'register')" })),
      limit: Type.Optional(Type.Number({ description: "Max results (default: 20)" })),
      label: Type.Optional(Type.String({ description: "Display name (for 'register')" })),
      aliases: Type.Optional(Type.Array(Type.String(), { description: "Keyword aliases for matching (for 'register')" })),
      description: Type.Optional(Type.String({ description: "Topic description (for 'register')" })),
    }),
    async execute(_id, params): Promise<ToolResult> {
      const action = params.action as string;

      switch (action) {
        case "trends":
          return showTrends(port, params);
        case "timeline":
          return showTimeline(port, params);
        case "register":
          return registerNewTopic(port, params);
        default:
          return { content: [{ type: "text", text: `Unknown action: ${action}. Use: trends, timeline, register` }] };
      }
    },
  };
}

async function showTrends(port: DatabasePort, params: Record<string, unknown>): Promise<ToolResult> {
  const limit = (params.limit as number) ?? 20;
  const trends = await port.getTopicTrends(limit);

  if (trends.length === 0) {
    return { content: [{ type: "text", text: "No topic activity recorded yet." }] };
  }

  const lines = ["## Topic Trends (last 30 days)", ""];
  for (const t of trends) {
    const bar = "█".repeat(Math.min(Math.round(t.trend_score), 20));
    lines.push(
      `**${t.label}** (\`${t.slug}\`) — score: ${t.trend_score} | events: ${t.event_count} | last 7d: ${t.recent_events} ${bar}`
    );
  }

  return {
    content: [{ type: "text", text: lines.join("\n") }],
    details: { count: trends.length, trends },
  };
}

async function showTimeline(port: DatabasePort, params: Record<string, unknown>): Promise<ToolResult> {
  const slug = params.slug as string | undefined;
  if (!slug) {
    return { content: [{ type: "text", text: "Error: 'slug' parameter required for timeline action" }] };
  }

  const limit = (params.limit as number) ?? 50;
  const events = await port.getTopicTimeline(slug, limit);

  if (events.length === 0) {
    return { content: [{ type: "text", text: `No events found for topic "${slug}".` }] };
  }

  const lines = [`## Timeline: ${slug} (${events.length} events)`, ""];
  for (const e of events) {
    const date = e.created_at.slice(0, 16).replace("T", " ");
    const summary = e.event_summary ? ` — ${e.event_summary.slice(0, 80)}` : "";
    const agent = e.agent_id ? ` [${e.agent_id.slice(0, 8)}]` : "";
    lines.push(`- \`${date}\` **${e.event_type}**${agent}${summary}`);
  }

  return {
    content: [{ type: "text", text: lines.join("\n") }],
    details: { slug, count: events.length },
  };
}

async function registerNewTopic(port: DatabasePort, params: Record<string, unknown>): Promise<ToolResult> {
  const slug = params.slug as string | undefined;
  const label = params.label as string | undefined;
  const aliases = params.aliases as string[] | undefined;

  if (!slug || !label) {
    return { content: [{ type: "text", text: "Error: 'slug' and 'label' parameters required for register action" }] };
  }

  await port.registerTopic(slug, label, aliases ?? [], (params.description as string) ?? undefined);

  return {
    content: [{ type: "text", text: `Topic registered: **${label}** (\`${slug}\`) with ${(aliases ?? []).length} aliases` }],
    details: { slug, label, aliases: aliases ?? [] },
  };
}
