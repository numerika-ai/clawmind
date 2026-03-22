import { Type } from "@sinclair/typebox";
import type { ToolDef, ToolResult } from "../types";
import type { DatabasePort } from "../db/port";

export function createUnifiedConversationsTool(port: DatabasePort): ToolDef {
  return {
    name: "unified_conversations",
    label: "Conversation Threads",
    description: "List or search conversation threads. Use to recall what was discussed.",
    parameters: Type.Object({
      status: Type.Optional(Type.String({ description: "Filter by status: active/resolved/blocked/archived/all (default: active)" })),
      query: Type.Optional(Type.String({ description: "Search topic/tags/summary" })),
      limit: Type.Optional(Type.Number({ description: "Max results (default: 10)" })),
      details: Type.Optional(Type.Boolean({ description: "Include full details and messages (default: false)" })),
    }),
    async execute(_id, params): Promise<ToolResult> {
      const status = (params.status as string) || 'active';
      const limit = Math.min((params.limit as number) || 10, 50);
      const query = (params.query as string) || '';
      const includeDetails = (params.details as boolean) || false;

      const conversations = await port.queryConversations({
        status: status === 'all' ? undefined : status,
        query: query || undefined,
        limit,
        includeMessages: includeDetails,
      });

      const text = JSON.stringify(conversations, null, 2);
      return {
        content: [{ type: "text" as const, text }],
        details: { count: conversations.length, status, query: query || undefined },
      };
    },
  };
}
