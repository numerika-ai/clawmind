import type { PluginApi } from "../types";
import type { DatabasePort } from "../db/port";
import type { UnifiedMemoryConfig } from "../config";
import type { MemoryBankConfig } from "../memory-bank/types";
import { autoTag } from "../utils/helpers";
import {
  extractKeywords,
  extractTopic,
  extractConversationTags,
  generateThreadId,
  isDecision,
  isActionRequest,
  isResolution,
  extractAgentFromSessionKey
} from "../utils/helpers";
import { extractFacts } from "../memory-bank/extractor";
import { consolidateFact } from "../memory-bank/consolidator";

// State variables shared across hooks
interface MemoryState {
  activeTrajectoryId: string | null;
  matchedSkillName: string | null;
  matchedSkillId: number | null;
  turnPrompt: string | null;
  agentId: string | null;
}

interface NativeLanceManager {
  isReady(): boolean;
  addEntry(entryId: number, text: string): Promise<boolean>;
}

interface HookDependencies {
  port: DatabasePort;
  lanceManager: NativeLanceManager | null;
  cfg: UnifiedMemoryConfig;
  memoryState: MemoryState;
  memoryBankConfig?: MemoryBankConfig;
}

/**
 * Tools worth logging — everything else (exec, read, write, process, web_fetch) is noise.
 * These tools carry decision/routing/config information that improves RAG quality.
 */
const TOOL_LOG_WHITELIST = new Set([
  "sessions_spawn",   // MoE routing decisions
  "message",          // communication decisions
  "gateway",          // config changes
  "cron",             // scheduled task changes
  "unified_store",    // explicit memory stores
]);

/**
 * Creates the tool call logging hook for after_tool_call
 */
export function createToolCallLogHook(deps: HookDependencies) {
  const { port, lanceManager, cfg, memoryState } = deps;

  // Resolve filter: config can override with "all", "none", or string[] of tool names
  const filterCfg = (cfg as any).logToolCallsFilter;
  const useWhitelist = filterCfg === "all" ? false
    : filterCfg === "none" ? true  // "none" means log nothing extra
    : Array.isArray(filterCfg) ? false
    : true; // default: use whitelist
  const customFilter: Set<string> | null = Array.isArray(filterCfg)
    ? new Set(filterCfg as string[])
    : null;

  return async function(api: PluginApi, event: Record<string, unknown>) {
    try {
      // OpenClaw may pass tool info in different field names
      const toolName = (event.toolName ?? event.name ?? event.tool ?? "unknown") as string;
      const params = (event.params ?? event.arguments ?? event.input) as Record<string, unknown> | undefined;
      const result = (event.result ?? event.output ?? "") as string;
      const error = (event.error ?? event.err) as string | undefined;

      // Skip our own tools and internal tools
      if (toolName.startsWith("skill_") || toolName.startsWith("unified_") || toolName === "artifact_register") return;
      if (toolName === "unknown") return;

      // Smart filtering: only log whitelisted tools (95% noise reduction)
      if (filterCfg === "none") return;
      if (customFilter && !customFilter.has(toolName)) return;
      if (useWhitelist && !TOOL_LOG_WHITELIST.has(toolName)) return;

      const paramsPreview = params ? JSON.stringify(params).slice(0, 300) : "";
      const resultStr = typeof result === "string" ? result : JSON.stringify(result ?? "");
      const resultPreview = error ? `ERROR: ${error}`.slice(0, 200) : resultStr.slice(0, 200);
      const status = error ? "error" : "success";

      // Store in unified_entries via port
      const tags = autoTag(`${toolName} ${paramsPreview}`);
      const summary = `${toolName}(${status}): ${paramsPreview.slice(0, 80)}`;
      const hnswKey = `tool:${toolName}:${Date.now()}`;

      const agentId = (event.agentId ?? event.agent_id ?? (globalThis as any).__openclawAgentId ?? extractAgentFromSessionKey(event.sessionKey as string | undefined) ?? "main") as string;
      const toolEntryId = await port.storeEntry({
        entryType: "tool",
        tags: tags.join(","),
        content: JSON.stringify({ tool: toolName, params: paramsPreview, result: resultPreview, status }),
        summary,
        hnswKey,
        agentId,
      });

      // Native HNSW indexing (fire and forget, don't block agent)
      if (lanceManager?.isReady()) {
        lanceManager.addEntry(toolEntryId, summary).catch(() => {});
      }
    } catch (err) {
      // Silently skip — tool logging should never break the agent
      api.logger.warn?.("memory-unified: tool log failed:", String(err).slice(0, 100));
    }
  };
}

/**
 * Creates the agent end hook for agent_end
 */
export function createAgentEndHook(deps: HookDependencies) {
  const { port, cfg, memoryState, memoryBankConfig } = deps;

  return async function(api: PluginApi, event: Record<string, unknown>) {
    // Always clear dynamic tool policy — prevent stale policies across turns
    (globalThis as any).__openclawDynamicToolPolicy = undefined;

    try {
      const success = event.success !== false;
      const response = (event.response ?? event.output ?? event.reply ?? "") as string;
      const responsePreview = typeof response === "string" ? response.slice(0, 500) : JSON.stringify(response).slice(0, 500);

      // ============================================================
      // SKILL EXECUTION LOGGING — closes the learning loop
      // ============================================================
      if (memoryState.matchedSkillName && memoryState.matchedSkillId) {
        try {
          const summary = `${memoryState.turnPrompt?.slice(0, 100) ?? "?"} → ${responsePreview.slice(0, 200)}`;

          await port.logSkillExecution(
            memoryState.matchedSkillId,
            summary,
            success ? "success" : "error",
            responsePreview.slice(0, 1000),
            (event.sessionKey as string) ?? "unknown"
          );

          await port.updateSkillStats(memoryState.matchedSkillId, success);

          api.logger.info?.(`memory-unified: logged execution for skill "${memoryState.matchedSkillName}" (${success ? "success" : "error"})`);

          // ============================================================
          // PATTERN EXTRACTION (Phase 1)
          // ============================================================
          try {
            const keywords = extractKeywords(memoryState.turnPrompt || "");
            if (keywords.length >= 3) {
              const keywordsJson = JSON.stringify(keywords.sort());

              const existingPatterns = await port.queryPatterns({
                skillName: memoryState.matchedSkillName,
                keywords: keywordsJson,
              });
              const existing = existingPatterns[0] as { id: number; confidence: number; success_count: number } | undefined;

              if (existing) {
                const newConf = Math.min(0.95, existing.confidence + 0.03);
                await port.updatePatternSuccess(existing.id, newConf);
                await port.logPatternHistory(existing.id, "success", existing.confidence, newConf, (memoryState.turnPrompt || "").slice(0, 200));
                api.logger.info?.(`memory-unified: pattern boosted for "${memoryState.matchedSkillName}" (${existing.confidence.toFixed(2)} -> ${newConf.toFixed(2)})`);
              } else {
                const patternId = await port.createPattern(memoryState.matchedSkillName, keywordsJson, 0.5);
                await port.logPatternHistory(patternId, "created", 0, 0.5, (memoryState.turnPrompt || "").slice(0, 200));
                api.logger.info?.(`memory-unified: new pattern created for "${memoryState.matchedSkillName}" with ${keywords.length} keywords`);
              }
            }
          } catch (patErr) {
            api.logger.warn?.("memory-unified: pattern extraction failed:", patErr);
          }

        } catch (logErr) {
          api.logger.warn?.("memory-unified: skill execution log failed:", logErr);
        }
      }

      // ============================================================
      // PATTERN FAILURE (Phase 1)
      // ============================================================
      if (memoryState.matchedSkillName && !success) {
        try {
          const failPatterns = await port.queryPatterns({ skillName: memoryState.matchedSkillName });

          for (const p of failPatterns) {
            const newConf = Math.max(0.05, p.confidence - 0.05);
            await port.updatePatternFailure(p.id, newConf);
            await port.logPatternHistory(p.id, "failure", p.confidence, newConf);
          }

          if (failPatterns.length > 0) {
            api.logger.info?.(`memory-unified: reduced confidence for ${failPatterns.length} patterns of "${memoryState.matchedSkillName}" (failure)`);
          }
        } catch (failPatErr) {
          api.logger.warn?.("memory-unified: pattern failure update failed:", failPatErr);
        }
      }

      // ============================================================
      // CONVERSATION TRACKING (Phase 5)
      // ============================================================
      try {
        const convPrompt = memoryState.turnPrompt || "";
        const convResponse = responsePreview || "";

        if (convPrompt.length > 20) {
          // Skip cron heartbeats, subagent contexts, and system reconnects
          const skipConv = /^\s*\[?cron:|HEARTBEAT_OK|\[Subagent Context\]|Auto-handoff check|WhatsApp gateway (dis)?connected/i.test(convPrompt);
          if (skipConv) {
            api.logger.info?.('memory-unified: CONV SKIP (system/cron message)');
            throw new Error('skip');  // caught by outer try/catch, no-op
          }
          const topic = extractTopic(convPrompt);
          const convTags = extractConversationTags(convPrompt, memoryState.matchedSkillName || undefined);
          const channel = convPrompt.match(/\[WhatsApp|Mattermost|Discord/i)?.[0]?.replace('[','') || 'unknown';

          // Find existing active conversation with similar tags
          const recentConversations = await port.queryConversations({
            status: 'active',
            recentHours: 2,
            limit: 5,
          });

          let conversationId: number | null = null;
          let isNewConversation = true;

          for (const conv of recentConversations) {
            const existingTags: string[] = JSON.parse(conv.tags || '[]');
            const overlap = convTags.filter((t: string) => existingTags.includes(t)).length;
            if (overlap >= 1 || conv.topic.toLowerCase().includes(topic.toLowerCase().slice(0, 20))) {
              conversationId = conv.id as number;
              isNewConversation = false;

              const newSummary = convResponse.length > 50
                ? convResponse.slice(0, 150).replace(/\n/g, ' ').trim()
                : conv.summary;

              await port.updateConversation(conversationId!, {
                summary: newSummary,
                tags: JSON.stringify([...new Set([...existingTags, ...convTags])]),
                incrementMessageCount: true,
                details: `[${new Date().toISOString().slice(11,16)}] ${topic.slice(0, 80)}`,
              });
              break;
            }
          }

          if (isNewConversation) {
            const threadId = generateThreadId(topic);
            const summary = convResponse.length > 50
              ? convResponse.slice(0, 150).replace(/\n/g, ' ').trim()
              : topic;

            conversationId = await port.createConversation({
              threadId,
              topic: topic.slice(0, 200),
              tags: JSON.stringify(convTags),
              channel,
              participants: JSON.stringify(['bartosz', 'wiki']),
              summary,
              details: `[${new Date().toISOString().slice(11,16)}] ${topic.slice(0, 200)}`,
              keyFacts: JSON.stringify([]),
            });
          }

          if (conversationId != null) {
            const cid = conversationId;
            const userSummary = convPrompt.slice(0, 200).replace(/\n/g, ' ').trim();
            const assistantSummary = convResponse.slice(0, 200).replace(/\n/g, ' ').trim();

            if (userSummary.length > 10) {
              await port.addConversationMessage(cid, 'user', userSummary, isDecision(convPrompt), isActionRequest(convPrompt));
            }

            if (assistantSummary.length > 10) {
              await port.addConversationMessage(cid, 'assistant', assistantSummary, isResolution(convResponse), false);
            }

            if (isResolution(convResponse) && isNewConversation) {
              await port.resolveConversation(cid);
            }
          }

          api.logger.info?.(`memory-unified: CONV ${isNewConversation ? 'NEW' : 'UPDATE'} thread=${conversationId} topic="${topic.slice(0,40)}" tags=${convTags.join(',')}`);
        }
      } catch (convErr) {
        api.logger.warn?.('memory-unified: conversation tracking error:', String(convErr));
      }

      // ============================================================
      // MEMORY BANK EXTRACTION (fire and forget)
      // ============================================================
      if (memoryBankConfig?.enabled) {
        try {
          const mbPrompt = memoryState.turnPrompt || "";
          const mbResponse = responsePreview || "";
          const conversationText = `User: ${mbPrompt}\nAssistant: ${mbResponse}`;

          // Skip if too short or cron/heartbeat
          const isCron = /^\s*\[?cron:|HEARTBEAT_OK|\[Subagent Context\]|Auto-handoff check/i.test(mbPrompt);
          if (!isCron && conversationText.length >= memoryBankConfig.minConversationLength) {
            const factScope = memoryState.agentId && memoryState.agentId !== "main" ? memoryState.agentId : "global";

            extractFacts(conversationText, memoryBankConfig)
              .then(async (facts) => {
                for (const fact of facts) {
                  try {
                    await consolidateFact(fact, port, memoryBankConfig, null, api.logger, factScope);
                  } catch (consErr) {
                    api.logger.warn?.("memory-bank: consolidation error:", String(consErr).slice(0, 100));
                  }
                }
                if (facts.length > 0) {
                  api.logger.info?.(`memory-bank: extracted ${facts.length} facts from conversation`);
                }
              })
              .catch((exErr) => {
                api.logger.warn?.("memory-bank: extraction error:", String(exErr).slice(0, 100));
              });
          }
        } catch (mbErr) {
          api.logger.warn?.("memory-bank: memory bank error:", String(mbErr).slice(0, 100));
        }
      }

      api.logger.info?.(`memory-unified: turn ended (skill: ${memoryState.matchedSkillName ?? "none"}, success: ${success})`);
    } catch (err) {
      api.logger.warn?.("memory-unified: agent_end failed:", err);
    } finally {
      memoryState.activeTrajectoryId = null;
      memoryState.matchedSkillName = null;
      memoryState.matchedSkillId = null;
      memoryState.turnPrompt = null;
      memoryState.agentId = null;
      (globalThis as any).__openclawAgentId = undefined;
      (globalThis as any).__openclawSessionKey = undefined;
    }
  };
}
