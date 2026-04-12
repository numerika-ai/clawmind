/**
 * session-state.ts — shared session state replacing globalThis pollution.
 *
 * memory-unified initializes TWICE per gateway process (once for [plugins]
 * context, once for [gateway] context). Both instances share this module
 * via Node.js require() cache, giving us a clean shared state bridge
 * without globalThis assignments.
 */

export interface SessionState {
  agentId: string;
  sessionKey: string;
  turnPrompt: string;
  dynamicToolPolicy?: { allow: string[] } | null;
}

const sessions = new Map<string, SessionState>();
let currentKey: string | null = null;

export function setSession(key: string, state: Partial<SessionState>): void {
  const existing = sessions.get(key);
  if (existing) {
    Object.assign(existing, state);
  } else {
    sessions.set(key, {
      agentId: state.agentId ?? 'unknown',
      sessionKey: key,
      turnPrompt: state.turnPrompt ?? '',
      dynamicToolPolicy: state.dynamicToolPolicy ?? null,
    });
  }
  currentKey = key;
}

export function getSession(key: string): SessionState | undefined {
  return sessions.get(key);
}

export function clearSession(key: string): void {
  sessions.delete(key);
  if (currentKey === key) currentKey = null;
}

/** Get the most recently set session (used by tools that don't have sessionKey in params). */
export function getCurrentSession(): SessionState | undefined {
  if (!currentKey) return undefined;
  return sessions.get(currentKey);
}

export function getCurrentAgentId(): string | undefined {
  return getCurrentSession()?.agentId;
}

export function getDynamicToolPolicy(): { allow: string[] } | null | undefined {
  return getCurrentSession()?.dynamicToolPolicy;
}

export function setDynamicToolPolicy(policy: { allow: string[] } | null): void {
  if (currentKey) {
    const s = sessions.get(currentKey);
    if (s) s.dynamicToolPolicy = policy;
  }
}

export function clearDynamicToolPolicy(): void {
  if (currentKey) {
    const s = sessions.get(currentKey);
    if (s) s.dynamicToolPolicy = null;
  }
}
