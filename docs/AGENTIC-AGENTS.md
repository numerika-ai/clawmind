# Agentic Agents — Autonomous Orchestration Architecture

**Version:** 1.0 (design)
**Date:** 2026-03-21
**Status:** Proposed
**Depends on:** memory-unified v4.0 (Phase 4 complete), OpenClaw sessions API

---

## 1. Philosophy

Agents are NOT tools. They are **active participants** in a collaborative system that self-organizes around goals. Each agent has autonomy, memory, the ability to delegate, and learns from experience.

Traditional pipeline: `User → Orchestrator → Tool → Result`
Agentic architecture: `User → Agent Team → [negotiate, delegate, learn] → Result`

The key difference: agents make **decisions**, not just execute instructions.

---

## 2. Agent Autonomy Levels

Five levels define what an agent can do without human approval:

| Level | Name | Description | Approval Required | Example |
|-------|------|-------------|-------------------|---------|
| **L0** | Executor | Does exactly what it's told. Zero decisions. | Every action | `calculator`, `web_fetch` |
| **L1** | Advisor | Analyzes, suggests, waits for approval before acting. | Before any side effect | `code_reviewer`, `security_scanner` |
| **L2** | Semi-autonomous | Acts independently within a defined scope/budget. Escalates edge cases. | Edge cases, budget overruns | `test_runner`, `deploy_staging` |
| **L3** | Autonomous | Full autonomy in its domain. Reports post-factum. | Never (within domain) | `memory_manager`, `log_analyst` |
| **L4** | Orchestrator | Creates sub-tasks, delegates to other agents, manages a team. | Strategic decisions only | `project_lead`, `incident_commander` |

### Autonomy Boundaries

Each agent declares its autonomy envelope:

```typescript
interface AgentAutonomy {
  level: 0 | 1 | 2 | 3 | 4;
  domain: string;                    // e.g., "memory_management", "code_review"
  allowed_actions: string[];         // actions agent can perform without approval
  forbidden_actions: string[];       // hard blocks (e.g., "delete_production_data")
  budget_limit?: {
    tokens_per_task: number;         // max LLM tokens per delegated task
    tasks_per_hour: number;          // rate limit
    total_cost_usd?: number;         // optional dollar cap
  };
  escalation_triggers: string[];     // conditions that force escalation
}
```

### Level Transitions

Agents can be promoted/demoted based on performance:

```
L0 ──(consistent success)──→ L1 ──(trust earned)──→ L2
L2 ──(domain mastery)──→ L3 ──(orchestration skill)──→ L4

L4 ──(critical failure)──→ L2 (demotion)
L3 ──(repeated errors)──→ L1 (demotion)
```

Promotion requires: `proficiency_score > 0.85` + `min_completed_tasks > 50` + `error_rate < 0.05`
Demotion triggers: `error_rate > 0.15` over last 20 tasks OR single critical failure.

---

## 3. Agent-to-Agent Communication

### 3.1 Knowledge Routing

When Agent A needs information outside its domain:

```
Agent A: "Who knows about Kubernetes deployments?"
    → query memory_facts WHERE topic = 'agent_capabilities'
    → find Agent B has proficiency_score 0.92 for 'kubernetes'
    → route question to Agent B
    → Agent B responds with answer + confidence
    → Agent A incorporates and continues
```

### 3.2 Task Delegation

When Agent A has too much work or lacks expertise:

```
Agent A (L4 Orchestrator):
    1. Decomposes task into sub-tasks
    2. Matches sub-tasks to agents by capability
    3. Creates delegation records
    4. Monitors progress
    5. Aggregates results
    6. Reports to user or parent orchestrator
```

### 3.3 Completion Notifications

When Agent A finishes a task, dependents are automatically informed:

```
Agent A completes task T1
    → query agent_delegations WHERE depends_on_task = T1
    → find Agent C is blocked on T1
    → send completion event to Agent C with results
    → Agent C unblocks and continues
```

### 3.4 Conflict Resolution

When two agents have contradictory facts or recommendations:

| Strategy | When to use | Mechanism |
|----------|-------------|-----------|
| **Confidence wins** | Both agents have the same domain | Higher `proficiency_score` agent's fact prevails |
| **Recency wins** | Temporal facts | Most recently updated fact wins |
| **Voting** | Multiple agents, no clear authority | Majority vote among domain-relevant agents |
| **Escalation** | Critical decisions, no consensus | Escalate to L4 orchestrator or human |

```
Agent A: "Database should use PostgreSQL" (confidence: 0.8)
Agent B: "Database should use SQLite" (confidence: 0.9)
    → Conflict detected (same topic, contradicting)
    → Strategy: confidence wins → SQLite
    → Record decision in agent_decisions with reasoning
    → Notify Agent A of resolution
```

---

## 4. Self-Learning Loop

### 4.1 Task Feedback Cycle

```
Agent executes task
    ↓
Outcome: success | failure | partial
    ↓
Update proficiency_score:
    success: score = score * 0.9 + 1.0 * 0.1  (EMA toward 1.0)
    failure: score = score * 0.9 + 0.0 * 0.1  (EMA toward 0.0)
    partial: score = score * 0.9 + 0.5 * 0.1  (EMA toward 0.5)
    ↓
Store in agent_feedback table
    ↓
If score drops below threshold → trigger demotion review
If score rises above threshold → trigger promotion review
```

### 4.2 Pattern Discovery

When an agent solves a novel problem:

```
Agent completes task successfully
    ↓
Compare approach to known patterns in memory_facts
    ↓
No match found → new pattern candidate
    ↓
Store as agent_learning record:
    pattern_type: "new_skill" | "optimization" | "workaround"
    proposed_by: agent_id
    evidence: [task_ids that demonstrate the pattern]
    status: "proposed"
    ↓
L4 Orchestrator reviews proposed patterns
    ↓
approved → becomes a reusable skill/protocol
rejected → archived with reason
```

### 4.3 Mistake-Based Learning

```
Agent fails a task
    ↓
Analyze failure:
    - What was attempted?
    - What went wrong?
    - What should have been done?
    ↓
Store as memory_fact:
    topic: "lesson_learned"
    temporal_type: "permanent"
    fact: "When doing X, avoid Y because Z"
    scope: agent_id (or "global" if broadly applicable)
    ↓
Next time agent encounters similar task:
    RAG retrieves lesson_learned facts
    Agent avoids known pitfalls
```

### 4.4 Periodic Calibration (Peer Review)

Every N tasks (configurable, default 100):

```
For each agent A:
    1. Select 5 random completed tasks
    2. Send to 2 peer agents for review
    3. Peers score: quality (0-1), efficiency (0-1), correctness (0-1)
    4. Store in agent_feedback with reviewer_agent_id
    5. Compute calibrated_score = avg(self_score, peer_scores)
    6. Update agent proficiency
```

---

## 5. Hierarchical Orchestration

Maps to OpenClaw's session model + Paperclip-style org structure:

```
┌──────────────────────────────────────────────────────────────┐
│                    CEO Agent (L4)                              │
│  Strategic decisions, goal decomposition, resource allocation  │
│  Session: main orchestrator                                    │
├──────────────┬──────────────┬──────────────┬─────────────────┤
│  Engineering  │  Research     │  Operations  │  Quality        │
│  Head (L3)   │  Head (L3)   │  Head (L3)   │  Head (L3)      │
│              │              │              │                 │
│  ┌─────────┐ │  ┌─────────┐ │  ┌─────────┐ │  ┌───────────┐ │
│  │Worker A │ │  │Worker D │ │  │Worker F │ │  │Reviewer H │ │
│  │(L2)     │ │  │(L2)     │ │  │(L1)     │ │  │(L1)       │ │
│  ├─────────┤ │  ├─────────┤ │  ├─────────┤ │  ├───────────┤ │
│  │Worker B │ │  │Worker E │ │  │Worker G │ │  │Reviewer I │ │
│  │(L2)     │ │  │(L1)     │ │  │(L0)     │ │  │(L1)       │ │
│  ├─────────┤ │  └─────────┘ │  └─────────┘ │  └───────────┘ │
│  │Worker C │ │              │              │                 │
│  │(L1)     │ │              │              │                 │
│  └─────────┘ │              │              │                 │
└──────────────┴──────────────┴──────────────┴─────────────────┘
         │              │              │              │
    ┌────┴────┐    ┌────┴────┐    ┌────┴────┐    ┌────┴────┐
    │ Support │    │ Support │    │ Support │    │ Support │
    │ (L0)    │    │ (L0)    │    │ (L0)    │    │ (L0)    │
    │ search  │    │ calc    │    │ monitor │    │ lint    │
    └─────────┘    └─────────┘    └─────────┘    └─────────┘
```

### Communication Flow

```
User: "Build a REST API for user management"
    ↓
CEO Agent (L4):
    1. Decompose: [design_schema, implement_api, write_tests, deploy_staging]
    2. Delegate: Engineering Head gets implement_api + design_schema
                 Quality Head gets write_tests
                 Operations Head gets deploy_staging
    3. Set dependencies: write_tests AFTER implement_api
                         deploy_staging AFTER write_tests
    ↓
Engineering Head (L3):
    1. Sub-delegate: Worker A → design_schema
                     Worker B → implement_api (blocked on schema)
    2. Monitor progress, unblock Worker B when A finishes
    ↓
Worker A (L2):
    1. Design schema autonomously (within scope)
    2. Store result, notify Engineering Head
    3. Engineering Head forwards to Worker B
    ↓
... pipeline continues ...
    ↓
CEO Agent: Aggregates all results, reports to user
```

---

## 6. Agentic Workflow Patterns

### 6.1 Chain (Pipeline)

```
A → B → C → D
```

Sequential processing. Each agent's output is the next agent's input. Best for: data transformation pipelines, multi-stage analysis.

```typescript
// Example: Code review pipeline
code_analyzer → security_scanner → style_checker → final_report
```

### 6.2 Fan-out / Fan-in

```
        ┌→ B ─┐
   A ───┤→ C ─├──→ E (merge)
        └→ D ─┘
```

Parallel execution with result aggregation. Best for: independent sub-tasks, competitive evaluation.

```typescript
// Example: Multi-source research
research_coordinator → [arxiv_agent, github_agent, docs_agent] → synthesis_agent
```

### 6.3 Negotiation

```
A ↔ B  (iterate until consensus)
```

Two agents exchange proposals and counter-proposals. Best for: design decisions, trade-off analysis.

```typescript
// Example: Architecture decision
performance_agent ↔ security_agent
// Round 1: perf proposes caching, security flags cache poisoning risk
// Round 2: perf proposes signed cache, security approves
// Result: signed cache architecture
```

### 6.4 Supervisor

```
     S (supervisor)
    / \
   A   B   (workers, monitored)
```

Supervisor watches workers, intervenes on failure or drift. Best for: critical operations, quality control.

```typescript
// Example: Deployment with safety
deploy_supervisor monitors [deploy_agent, rollback_agent]
// If deploy_agent reports error rate > 5% → supervisor triggers rollback_agent
```

### 6.5 Swarm

```
   ┌─── A ───┐
   │    │     │
   B ── C ── D
   │    │     │
   └─── E ───┘
```

N agents collaborate on a shared knowledge base (memory-unified). No fixed hierarchy — agents self-organize based on expertise. Best for: complex research, exploration, creative tasks.

```typescript
// Example: Bug investigation
// All agents read/write to shared memory_facts
// Each agent explores different hypothesis
// When one finds evidence, others incorporate it
// Swarm converges on root cause
```

---

## 7. Database Schema for Agentic Behavior

### 7.1 `agent_registry` — Agent Identity & Capabilities

```sql
CREATE TABLE IF NOT EXISTS agent_registry (
    id TEXT PRIMARY KEY,                          -- unique agent identifier (e.g., 'eng-worker-01')
    display_name TEXT NOT NULL,                   -- human-readable name
    autonomy_level INTEGER NOT NULL DEFAULT 0     -- 0-4 (L0 through L4)
        CHECK(autonomy_level BETWEEN 0 AND 4),
    domain TEXT NOT NULL,                         -- primary domain (e.g., 'code_review', 'deployment')
    parent_agent_id TEXT REFERENCES agent_registry(id),  -- hierarchical parent (NULL = top-level)
    status TEXT DEFAULT 'active'                  -- active | paused | retired
        CHECK(status IN ('active', 'paused', 'retired')),
    proficiency_score REAL DEFAULT 0.5            -- 0.0-1.0, EMA-updated
        CHECK(proficiency_score BETWEEN 0.0 AND 1.0),
    allowed_actions TEXT,                         -- JSON array of allowed action names
    forbidden_actions TEXT,                       -- JSON array of hard-blocked actions
    budget_tokens_per_task INTEGER DEFAULT 10000, -- max LLM tokens per task
    budget_tasks_per_hour INTEGER DEFAULT 20,     -- rate limit
    total_tasks_completed INTEGER DEFAULT 0,
    total_tasks_failed INTEGER DEFAULT 0,
    capabilities TEXT,                            -- JSON array of skill/topic tags
    session_id TEXT,                              -- OpenClaw session this agent runs in
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_agent_domain ON agent_registry(domain);
CREATE INDEX IF NOT EXISTS idx_agent_parent ON agent_registry(parent_agent_id);
CREATE INDEX IF NOT EXISTS idx_agent_status ON agent_registry(status);
CREATE INDEX IF NOT EXISTS idx_agent_level ON agent_registry(autonomy_level);
```

**Example queries:**

```sql
-- Find all active agents in a domain
SELECT id, display_name, proficiency_score
FROM agent_registry
WHERE domain = 'code_review' AND status = 'active'
ORDER BY proficiency_score DESC;

-- Get org chart (direct reports)
SELECT id, display_name, autonomy_level
FROM agent_registry
WHERE parent_agent_id = 'eng-head'
ORDER BY autonomy_level DESC;

-- Find best agent for a capability
SELECT id, display_name, proficiency_score
FROM agent_registry
WHERE status = 'active'
  AND capabilities LIKE '%"kubernetes"%'
ORDER BY proficiency_score DESC
LIMIT 1;

-- Agents eligible for promotion (L2 → L3)
SELECT id, display_name, proficiency_score, total_tasks_completed
FROM agent_registry
WHERE autonomy_level = 2
  AND proficiency_score > 0.85
  AND total_tasks_completed > 50
  AND (CAST(total_tasks_failed AS REAL) / total_tasks_completed) < 0.05;
```

### 7.2 `agent_delegations` — Task Delegation Graph

```sql
CREATE TABLE IF NOT EXISTS agent_delegations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT NOT NULL UNIQUE,                  -- unique task identifier (UUID)
    delegator_id TEXT NOT NULL                     -- agent who created/delegated this task
        REFERENCES agent_registry(id),
    assignee_id TEXT                               -- agent assigned to execute (NULL = unassigned)
        REFERENCES agent_registry(id),
    parent_task_id TEXT                            -- parent task (for sub-task hierarchy)
        REFERENCES agent_delegations(task_id),
    title TEXT NOT NULL,                           -- short task description
    description TEXT,                              -- full task context
    input_context TEXT,                            -- JSON: input data, parameters, constraints
    output_result TEXT,                            -- JSON: result data (filled on completion)
    status TEXT DEFAULT 'pending'                  -- pending | assigned | in_progress | blocked |
        CHECK(status IN (                         -- completed | failed | cancelled
            'pending', 'assigned', 'in_progress',
            'blocked', 'completed', 'failed', 'cancelled'
        )),
    priority INTEGER DEFAULT 5                    -- 1 (lowest) to 10 (highest)
        CHECK(priority BETWEEN 1 AND 10),
    depends_on_tasks TEXT,                        -- JSON array of task_ids that must complete first
    blocked_reason TEXT,                          -- why is this task blocked (if status = blocked)
    autonomy_required INTEGER DEFAULT 0           -- minimum autonomy level to execute
        CHECK(autonomy_required BETWEEN 0 AND 4),
    budget_tokens INTEGER,                        -- token budget allocated for this task
    tokens_used INTEGER DEFAULT 0,                -- tokens consumed so far
    deadline_at TIMESTAMP,                        -- optional deadline
    assigned_at TIMESTAMP,
    started_at TIMESTAMP,
    completed_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_deleg_delegator ON agent_delegations(delegator_id);
CREATE INDEX IF NOT EXISTS idx_deleg_assignee ON agent_delegations(assignee_id);
CREATE INDEX IF NOT EXISTS idx_deleg_status ON agent_delegations(status);
CREATE INDEX IF NOT EXISTS idx_deleg_parent ON agent_delegations(parent_task_id);
CREATE INDEX IF NOT EXISTS idx_deleg_priority ON agent_delegations(priority DESC);
```

**Example queries:**

```sql
-- Get all pending tasks for an agent
SELECT task_id, title, priority, delegator_id
FROM agent_delegations
WHERE assignee_id = 'eng-worker-01'
  AND status IN ('assigned', 'in_progress')
ORDER BY priority DESC, created_at ASC;

-- Check if all dependencies are met for a blocked task
SELECT d.task_id, d.title,
    (SELECT COUNT(*) FROM agent_delegations dep
     WHERE dep.task_id IN (SELECT value FROM json_each(d.depends_on_tasks))
       AND dep.status != 'completed') AS unmet_deps
FROM agent_delegations d
WHERE d.status = 'blocked';

-- Task tree for a parent task (all sub-tasks recursively)
WITH RECURSIVE task_tree AS (
    SELECT task_id, title, status, assignee_id, 0 AS depth
    FROM agent_delegations
    WHERE task_id = 'root-task-uuid'
    UNION ALL
    SELECT d.task_id, d.title, d.status, d.assignee_id, t.depth + 1
    FROM agent_delegations d
    JOIN task_tree t ON d.parent_task_id = t.task_id
)
SELECT * FROM task_tree ORDER BY depth, task_id;

-- Token budget utilization per orchestrator
SELECT delegator_id,
    SUM(budget_tokens) AS total_budget,
    SUM(tokens_used) AS total_used,
    ROUND(100.0 * SUM(tokens_used) / SUM(budget_tokens), 1) AS pct_used
FROM agent_delegations
WHERE status IN ('in_progress', 'completed')
GROUP BY delegator_id;

-- Overdue tasks
SELECT task_id, title, assignee_id, deadline_at
FROM agent_delegations
WHERE deadline_at < CURRENT_TIMESTAMP
  AND status NOT IN ('completed', 'failed', 'cancelled')
ORDER BY deadline_at ASC;
```

### 7.3 `agent_decisions` — Autonomous Decision Log

Every autonomous decision (L2+) is logged for audit and learning:

```sql
CREATE TABLE IF NOT EXISTS agent_decisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id TEXT NOT NULL
        REFERENCES agent_registry(id),
    task_id TEXT                                   -- related task (optional)
        REFERENCES agent_delegations(task_id),
    decision_type TEXT NOT NULL                    -- categorize the decision
        CHECK(decision_type IN (
            'delegate', 'escalate', 'approve', 'reject',
            'retry', 'abort', 'override', 'promote', 'demote',
            'create_subtask', 'resolve_conflict', 'budget_realloc'
        )),
    description TEXT NOT NULL,                    -- what was decided
    reasoning TEXT NOT NULL,                      -- why (chain of thought, factors considered)
    alternatives_considered TEXT,                 -- JSON array of other options and why rejected
    confidence REAL DEFAULT 0.8                   -- agent's self-assessed confidence
        CHECK(confidence BETWEEN 0.0 AND 1.0),
    outcome TEXT,                                 -- result of this decision (filled post-factum)
    outcome_score REAL,                           -- 0-1, how well did this decision work out
        -- CHECK(outcome_score IS NULL OR outcome_score BETWEEN 0.0 AND 1.0),
    was_overridden INTEGER DEFAULT 0,             -- 1 if human or higher agent overrode this
    override_reason TEXT,                         -- why it was overridden
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    evaluated_at TIMESTAMP                        -- when outcome was assessed
);

CREATE INDEX IF NOT EXISTS idx_decision_agent ON agent_decisions(agent_id);
CREATE INDEX IF NOT EXISTS idx_decision_type ON agent_decisions(decision_type);
CREATE INDEX IF NOT EXISTS idx_decision_task ON agent_decisions(task_id);
CREATE INDEX IF NOT EXISTS idx_decision_confidence ON agent_decisions(confidence);
```

**Example queries:**

```sql
-- Audit trail: all decisions by an agent in the last 24h
SELECT decision_type, description, reasoning, confidence, outcome
FROM agent_decisions
WHERE agent_id = 'eng-head'
  AND created_at > datetime('now', '-1 day')
ORDER BY created_at DESC;

-- Find decisions that were overridden (learning signal)
SELECT agent_id, decision_type, description, override_reason
FROM agent_decisions
WHERE was_overridden = 1
ORDER BY created_at DESC
LIMIT 20;

-- Decision quality by agent (which agents make good autonomous decisions?)
SELECT agent_id,
    COUNT(*) AS total_decisions,
    ROUND(AVG(outcome_score), 3) AS avg_outcome,
    SUM(was_overridden) AS times_overridden,
    ROUND(100.0 * SUM(was_overridden) / COUNT(*), 1) AS override_pct
FROM agent_decisions
WHERE outcome_score IS NOT NULL
GROUP BY agent_id
ORDER BY avg_outcome DESC;

-- Escalation patterns (are agents escalating too much or too little?)
SELECT agent_id,
    SUM(CASE WHEN decision_type = 'escalate' THEN 1 ELSE 0 END) AS escalations,
    COUNT(*) AS total,
    ROUND(100.0 * SUM(CASE WHEN decision_type = 'escalate' THEN 1 ELSE 0 END) / COUNT(*), 1) AS escalation_pct
FROM agent_decisions
GROUP BY agent_id
HAVING total > 10
ORDER BY escalation_pct DESC;
```

### 7.4 `agent_feedback` — Peer Review & Quality Scoring

```sql
CREATE TABLE IF NOT EXISTS agent_feedback (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    subject_agent_id TEXT NOT NULL                 -- agent being reviewed
        REFERENCES agent_registry(id),
    reviewer_agent_id TEXT                         -- reviewing agent (NULL = self or system)
        REFERENCES agent_registry(id),
    reviewer_type TEXT DEFAULT 'self'              -- self | peer | supervisor | human | system
        CHECK(reviewer_type IN ('self', 'peer', 'supervisor', 'human', 'system')),
    task_id TEXT                                   -- task being reviewed
        REFERENCES agent_delegations(task_id),
    quality_score REAL                             -- 0-1: how good was the output
        CHECK(quality_score IS NULL OR quality_score BETWEEN 0.0 AND 1.0),
    efficiency_score REAL                          -- 0-1: token/time efficiency
        CHECK(efficiency_score IS NULL OR efficiency_score BETWEEN 0.0 AND 1.0),
    correctness_score REAL                         -- 0-1: was the result correct
        CHECK(correctness_score IS NULL OR correctness_score BETWEEN 0.0 AND 1.0),
    overall_score REAL                             -- 0-1: composite score
        CHECK(overall_score IS NULL OR overall_score BETWEEN 0.0 AND 1.0),
    feedback_text TEXT,                            -- qualitative feedback
    tags TEXT,                                     -- JSON array of tags (e.g., ["thorough", "slow"])
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_feedback_subject ON agent_feedback(subject_agent_id);
CREATE INDEX IF NOT EXISTS idx_feedback_reviewer ON agent_feedback(reviewer_agent_id);
CREATE INDEX IF NOT EXISTS idx_feedback_task ON agent_feedback(task_id);
CREATE INDEX IF NOT EXISTS idx_feedback_type ON agent_feedback(reviewer_type);
```

**Example queries:**

```sql
-- Agent performance summary (all feedback types)
SELECT
    subject_agent_id,
    reviewer_type,
    COUNT(*) AS reviews,
    ROUND(AVG(quality_score), 3) AS avg_quality,
    ROUND(AVG(efficiency_score), 3) AS avg_efficiency,
    ROUND(AVG(correctness_score), 3) AS avg_correctness,
    ROUND(AVG(overall_score), 3) AS avg_overall
FROM agent_feedback
GROUP BY subject_agent_id, reviewer_type
ORDER BY subject_agent_id, reviewer_type;

-- Self-assessment vs peer assessment gap (calibration check)
SELECT
    f_self.subject_agent_id,
    ROUND(AVG(f_self.overall_score), 3) AS self_score,
    ROUND(AVG(f_peer.overall_score), 3) AS peer_score,
    ROUND(AVG(f_self.overall_score) - AVG(f_peer.overall_score), 3) AS gap
FROM agent_feedback f_self
JOIN agent_feedback f_peer
    ON f_self.subject_agent_id = f_peer.subject_agent_id
    AND f_self.task_id = f_peer.task_id
WHERE f_self.reviewer_type = 'self'
  AND f_peer.reviewer_type = 'peer'
GROUP BY f_self.subject_agent_id
HAVING COUNT(DISTINCT f_peer.id) >= 5;

-- Worst-performing agents (need attention)
SELECT subject_agent_id,
    COUNT(*) AS total_reviews,
    ROUND(AVG(overall_score), 3) AS avg_score
FROM agent_feedback
WHERE reviewer_type IN ('peer', 'supervisor')
  AND created_at > datetime('now', '-7 days')
GROUP BY subject_agent_id
HAVING avg_score < 0.5
ORDER BY avg_score ASC;
```

### 7.5 `agent_learning` — Pattern Discovery & Skill Proposals

```sql
CREATE TABLE IF NOT EXISTS agent_learning (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    proposer_agent_id TEXT NOT NULL                -- agent that discovered the pattern
        REFERENCES agent_registry(id),
    pattern_type TEXT NOT NULL
        CHECK(pattern_type IN (
            'new_skill', 'optimization', 'workaround',
            'anti_pattern', 'best_practice', 'integration'
        )),
    title TEXT NOT NULL,                          -- short name for the pattern
    description TEXT NOT NULL,                    -- detailed description
    evidence_task_ids TEXT,                       -- JSON array of task_ids that demonstrate this
    proposed_skill_procedure TEXT,                -- if new_skill: the procedure text
    applicability TEXT,                           -- when to apply this pattern
    status TEXT DEFAULT 'proposed'
        CHECK(status IN ('proposed', 'under_review', 'approved', 'rejected', 'superseded')),
    review_notes TEXT,                            -- orchestrator's review comments
    reviewed_by TEXT                              -- agent or human who reviewed
        REFERENCES agent_registry(id),
    times_applied INTEGER DEFAULT 0,             -- how often this pattern has been used
    success_rate REAL DEFAULT 0.0,               -- success rate when applied
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    reviewed_at TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_learning_proposer ON agent_learning(proposer_agent_id);
CREATE INDEX IF NOT EXISTS idx_learning_type ON agent_learning(pattern_type);
CREATE INDEX IF NOT EXISTS idx_learning_status ON agent_learning(status);
```

**Example queries:**

```sql
-- Approved patterns ready for use
SELECT title, description, applicability, success_rate, times_applied
FROM agent_learning
WHERE status = 'approved'
ORDER BY success_rate DESC, times_applied DESC;

-- Pending proposals needing review
SELECT l.title, l.pattern_type, l.description,
    r.display_name AS proposed_by, l.created_at
FROM agent_learning l
JOIN agent_registry r ON r.id = l.proposer_agent_id
WHERE l.status = 'proposed'
ORDER BY l.created_at ASC;

-- Most productive pattern proposers
SELECT proposer_agent_id,
    COUNT(*) AS total_proposed,
    SUM(CASE WHEN status = 'approved' THEN 1 ELSE 0 END) AS approved,
    ROUND(100.0 * SUM(CASE WHEN status = 'approved' THEN 1 ELSE 0 END) / COUNT(*), 1) AS approval_rate
FROM agent_learning
GROUP BY proposer_agent_id
HAVING total_proposed >= 3
ORDER BY approval_rate DESC;

-- Anti-patterns to avoid (inject into RAG)
SELECT title, description, applicability
FROM agent_learning
WHERE pattern_type = 'anti_pattern' AND status = 'approved'
ORDER BY times_applied DESC;
```

### 7.6 `agent_messages` — Inter-Agent Communication Log

```sql
CREATE TABLE IF NOT EXISTS agent_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_agent_id TEXT NOT NULL
        REFERENCES agent_registry(id),
    to_agent_id TEXT NOT NULL
        REFERENCES agent_registry(id),
    message_type TEXT NOT NULL
        CHECK(message_type IN (
            'request', 'response', 'notification',
            'escalation', 'delegation', 'conflict',
            'completion', 'heartbeat'
        )),
    task_id TEXT                                   -- related task (optional)
        REFERENCES agent_delegations(task_id),
    content TEXT NOT NULL,                         -- message content (text or JSON)
    priority INTEGER DEFAULT 5
        CHECK(priority BETWEEN 1 AND 10),
    acknowledged INTEGER DEFAULT 0,                -- 1 if recipient processed this
    acknowledged_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_msg_from ON agent_messages(from_agent_id);
CREATE INDEX IF NOT EXISTS idx_msg_to ON agent_messages(to_agent_id);
CREATE INDEX IF NOT EXISTS idx_msg_type ON agent_messages(message_type);
CREATE INDEX IF NOT EXISTS idx_msg_task ON agent_messages(task_id);
CREATE INDEX IF NOT EXISTS idx_msg_unack ON agent_messages(to_agent_id, acknowledged)
    WHERE acknowledged = 0;
```

**Example queries:**

```sql
-- Unread messages for an agent
SELECT from_agent_id, message_type, content, priority, created_at
FROM agent_messages
WHERE to_agent_id = 'eng-worker-01' AND acknowledged = 0
ORDER BY priority DESC, created_at ASC;

-- Communication volume between agents (find bottlenecks)
SELECT from_agent_id, to_agent_id, COUNT(*) AS msg_count
FROM agent_messages
WHERE created_at > datetime('now', '-1 day')
GROUP BY from_agent_id, to_agent_id
ORDER BY msg_count DESC
LIMIT 10;

-- Escalation frequency (are lower agents overwhelmed?)
SELECT from_agent_id, COUNT(*) AS escalations
FROM agent_messages
WHERE message_type = 'escalation'
  AND created_at > datetime('now', '-7 days')
GROUP BY from_agent_id
ORDER BY escalations DESC;
```

---

## 8. Human-in-the-Loop

### 8.1 Approval Gates by Autonomy Level

| Level | What requires human approval | How |
|-------|------------------------------|-----|
| L0 | Every action | Synchronous prompt, agent blocks until approved |
| L1 | All side effects (writes, sends, deploys) | Approval queue, agent can continue analysis while waiting |
| L2 | Actions outside defined scope, budget >80% consumed | Async notification, auto-approve after timeout (configurable) |
| L3 | Nothing within domain (post-factum report) | Daily digest of decisions + outcomes |
| L4 | Strategic pivots, budget reallocation >20%, new agent creation | Synchronous for critical, async for routine |

### 8.2 Budget Checkpoints

```
Task starts with budget = 10,000 tokens
    ↓
At 50% (5,000 tokens): log warning in agent_decisions
At 80% (8,000 tokens): auto-pause, notify supervisor/human
    ↓
Options:
    a) Human approves additional budget → continue
    b) Supervisor reallocates from another task → continue
    c) Agent summarizes progress + asks for guidance → partial result
    d) Timeout → task marked as 'failed', reason: 'budget_exhausted'
```

### 8.3 Escalation Paths

```
Worker Agent (L0-L2)
    ↓ escalation
Department Head (L3)
    ↓ can't resolve
Orchestrator (L4)
    ↓ critical/unclear
Human Operator
```

Each escalation includes:
- Original task context
- What was attempted
- Why escalation is needed
- Agent's recommended action (if any)
- Urgency level (1-10)

### 8.4 Override Protocol

A human (or higher-level agent) can take over any task at any time:

```sql
-- Override: reassign task to human
UPDATE agent_delegations
SET assignee_id = 'human-operator',
    status = 'assigned'
WHERE task_id = 'task-uuid';

-- Log the override decision
INSERT INTO agent_decisions (
    agent_id, task_id, decision_type, description, reasoning, was_overridden, override_reason
) VALUES (
    'human-operator', 'task-uuid', 'override',
    'Human took over API design task',
    'Agent was producing incorrect schema after 3 attempts',
    0, NULL  -- this IS the override, not being overridden
);

-- Notify the original agent
INSERT INTO agent_messages (
    from_agent_id, to_agent_id, message_type, task_id, content, priority
) VALUES (
    'human-operator', 'eng-worker-01', 'notification', 'task-uuid',
    'Task reassigned to human operator. Reason: schema quality concerns. Stand by for revised requirements.',
    8
);
```

### 8.5 Emergency Stop

Global kill switch that pauses all autonomous agents:

```sql
-- Pause all L2+ agents (keep L0-L1 as they require approval anyway)
UPDATE agent_registry
SET status = 'paused'
WHERE autonomy_level >= 2 AND status = 'active';

-- Cancel all in-progress tasks
UPDATE agent_delegations
SET status = 'cancelled', completed_at = CURRENT_TIMESTAMP
WHERE status IN ('in_progress', 'assigned')
  AND assignee_id IN (SELECT id FROM agent_registry WHERE status = 'paused');
```

---

## 9. Integration with memory-unified

### 9.1 RAG Context Enrichment

When an agent receives a task, RAG injects:
1. **Domain facts** — `memory_facts` WHERE topic matches agent's domain
2. **Lesson learned** — facts with `temporal_type = 'lesson_learned'` for this agent
3. **Active patterns** — approved `agent_learning` records relevant to the task
4. **Team context** — what sibling agents are working on (from `agent_delegations`)

### 9.2 Fact Ownership

`memory_facts.agent_id` maps to `agent_registry.id`:
- Facts discovered by an agent are scoped to that agent by default
- L3+ agents can promote facts to `scope = 'global'`
- Cross-agent fact sharing happens via the RAG pipeline

### 9.3 Proficiency as Memory

Agent capabilities are stored as `memory_facts`:

```sql
INSERT INTO memory_facts (topic, fact, confidence, scope, temporal_type, agent_id)
VALUES (
    'agent_capabilities',
    'Agent eng-worker-01 has proficiency 0.92 in kubernetes deployment',
    0.92,
    'global',
    'current_state',
    'system'
);
```

This makes agent capabilities discoverable via semantic search — any agent can ask "who knows about X?" and the RAG pipeline finds the answer.

---

## 10. Implementation Roadmap

| Phase | Scope | Dependencies |
|-------|-------|-------------|
| **Phase A** | `agent_registry` + `agent_delegations` tables, basic L0-L2 agents | memory-unified v4 |
| **Phase B** | `agent_decisions` + `agent_feedback`, self-learning loop | Phase A |
| **Phase C** | `agent_learning` + `agent_messages`, peer review, pattern discovery | Phase B |
| **Phase D** | L3-L4 orchestration, hierarchical delegation, swarm patterns | Phase C |
| **Phase E** | Human-in-the-loop gates, budget system, emergency stop | Phase D |

---

*Generated by Claude Code — 2026-03-21*
