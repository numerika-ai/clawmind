#!/usr/bin/env npx ts-node
/**
 * migrate-sqlite-to-postgres.ts
 * 
 * One-time migration of memory-unified data from SQLite to Postgres (Phase 1 schema).
 * Phase 1 uses UUIDs for agent_id/company_id with FK constraints.
 * 
 * Usage: npx ts-node scripts/migrate-sqlite-to-postgres.ts
 */

import Database from "better-sqlite3";
import { Pool } from "pg";

const SQLITE_PATH = process.env.SQLITE_PATH || "/home/tank/.openclaw/workspace/skill-memory.db";
const POSTGRES_URL = process.env.POSTGRES_URL || "postgresql://openclaw:OpenClaw2026!@192.168.1.76:5432/openclaw_platform";

// Phase 1 seed data UUIDs
const WIKI_AGENT_ID = "f551d6b6-3d4e-487b-99b1-a16cbb0b28c3";
const COMPANY_ID = "a1b2c3d4-0000-0000-0000-000000000001";

const sdb = new Database(SQLITE_PATH, { readonly: true });
const pool = new Pool({ connectionString: POSTGRES_URL });

async function migrate() {
  const client = await pool.connect();
  
  try {
    await client.query("BEGIN");
    console.log("🚀 Starting migration SQLite → Postgres (Phase 1 schema)...\n");

    // 1. Skills → agent_skills (Phase 1 schema: skill_name, not name)
    const skills = sdb.prepare("SELECT * FROM skills").all() as any[];
    console.log(`📦 Skills: ${skills.length}`);
    for (const s of skills) {
      const useCount = s.use_count || 0;
      const successRate = s.success_rate || 0.5;
      const succeeded = Math.round(useCount * successRate);
      const failed = useCount - succeeded;
      await client.query(
        `INSERT INTO openclaw.agent_skills (company_id, agent_id, skill_name, proficiency_score, times_used, times_succeeded, times_failed, last_used_at, notes, created_at, updated_at)
         VALUES ($1,$2,$3,$4::real,$5::int,$6::int,$7::int,$8,$9,$10,$11)
         ON CONFLICT (agent_id, skill_name) DO UPDATE SET 
           times_used=EXCLUDED.times_used, proficiency_score=EXCLUDED.proficiency_score, 
           last_used_at=EXCLUDED.last_used_at, updated_at=NOW()`,
        [COMPANY_ID, WIKI_AGENT_ID, s.name, successRate, useCount, succeeded, failed, s.last_used, s.description, s.created_at, s.updated_at || s.created_at]
      );
    }
    console.log(`   ✅ ${skills.length} skills migrated`);

    // 2. Unified entries → agent_entries
    const entries = sdb.prepare("SELECT * FROM unified_entries").all() as any[];
    console.log(`📦 Unified entries: ${entries.length}`);
    let entryMap: Record<number, number> = {};
    for (const e of entries) {
      const res = await client.query(
        `INSERT INTO openclaw.agent_entries (company_id, agent_id, entry_type, tags, content, summary, source_path, hnsw_key, access_count, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         RETURNING id`,
        [COMPANY_ID, WIKI_AGENT_ID, e.entry_type, e.tags, e.content, e.summary, e.source_path, e.hnsw_key, e.access_count || 0, e.created_at, e.updated_at || e.created_at]
      );
      entryMap[e.id] = res.rows[0].id;
    }
    console.log(`   ✅ ${entries.length} entries migrated`);

    // 3. Memory facts → agent_knowledge
    const facts = sdb.prepare("SELECT * FROM memory_facts").all() as any[];
    console.log(`📦 Memory facts: ${facts.length}`);
    let factMap: Record<number, number> = {};
    for (const f of facts) {
      const res = await client.query(
        `INSERT INTO openclaw.agent_knowledge (company_id, topic, fact, agent_id, scope, confidence, usage_count, last_used_at, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         RETURNING id`,
        [COMPANY_ID, f.topic, f.fact, WIKI_AGENT_ID, f.scope === 'global' ? 'shared' : 'private', f.confidence || 0.8, f.access_count || 0, f.last_accessed, f.created_at, f.updated_at || f.created_at]
      );
      factMap[f.id] = res.rows[0].id;
    }
    console.log(`   ✅ ${facts.length} facts migrated`);

    // 4. Conversations → agent_conversations
    const convs = sdb.prepare("SELECT * FROM conversations").all() as any[];
    console.log(`📦 Conversations: ${convs.length}`);
    let convMap: Record<number, number> = {};
    for (const c of convs) {
      // Map SQLite statuses to Phase 1 check constraint: active|completed|archived|escalated
      let pgStatus = c.status || 'active';
      if (!['active','completed','archived','escalated'].includes(pgStatus)) {
        pgStatus = pgStatus === 'resolved' ? 'completed' : 'active';
      }
      const res = await client.query(
        `INSERT INTO openclaw.agent_conversations (company_id, thread_id, primary_agent_id, topic, context_summary, status, message_count, started_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (thread_id) DO NOTHING
         RETURNING id`,
        [COMPANY_ID, c.thread_id || `conv-${c.id}`, WIKI_AGENT_ID, c.topic || 'untitled', c.summary, pgStatus, c.message_count || 0, c.created_at || new Date().toISOString(), c.updated_at || c.created_at || new Date().toISOString()]
      );
      if (res.rows.length === 0) { 
        // ON CONFLICT — get existing id
        const existing = await client.query(`SELECT id FROM openclaw.agent_conversations WHERE thread_id=$1`, [c.thread_id || `conv-${c.id}`]);
        if (existing.rows.length) convMap[c.id] = existing.rows[0].id;
        continue;
      }
      convMap[c.id] = res.rows[0].id;
    }
    console.log(`   ✅ ${convs.length} conversations migrated`);

    // 5. Conversation messages → agent_conversation_messages (if table exists from postgres.ts init)
    try {
      const msgs = sdb.prepare("SELECT * FROM conversation_messages").all() as any[];
      console.log(`📦 Conversation messages: ${msgs.length}`);
      // Check if agent_conversation_messages exists
      const tableCheck = await client.query(
        `SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='openclaw' AND table_name='agent_conversation_messages')`
      );
      if (tableCheck.rows[0].exists) {
        for (const m of msgs) {
          const newConvId = convMap[m.conversation_id] || m.conversation_id;
          await client.query(
            `INSERT INTO openclaw.agent_conversation_messages (conversation_id, role, content_summary, has_decision, has_action, timestamp)
             VALUES ($1,$2,$3,$4,$5,$6)`,
            [newConvId, m.role, m.content_summary, m.has_decision || false, m.has_action || false, m.timestamp]
          );
        }
        console.log(`   ✅ ${msgs.length} messages migrated`);
      } else {
        console.log(`   ⚠️ agent_conversation_messages table not found, skipping`);
      }
    } catch (e: any) {
      console.log(`   ⚠️ messages skipped: ${e.message?.slice(0,80)}`);
    }

    // 6. Patterns → agent_patterns
    const patterns = sdb.prepare("SELECT * FROM patterns").all() as any[];
    console.log(`📦 Patterns: ${patterns.length}`);
    let patternMap: Record<number, number> = {};
    for (const p of patterns) {
      const res = await client.query(
        `INSERT INTO openclaw.agent_patterns (company_id, agent_id, skill_name, keywords, confidence, success_count, failure_count, last_matched_at, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         RETURNING id`,
        [COMPANY_ID, WIKI_AGENT_ID, p.skill_name || 'unknown', p.keywords || '', p.confidence || 0.5, p.occurrence_count || 1, 0, p.updated_at, p.created_at, p.updated_at || p.created_at]
      );
      patternMap[p.id] = res.rows[0].id;
    }
    console.log(`   ✅ ${patterns.length} patterns migrated`);

    // 7. Pattern history → agent_pattern_history (create if not exists)
    const pHistory = sdb.prepare("SELECT * FROM pattern_history").all() as any[];
    console.log(`📦 Pattern history: ${pHistory.length}`);
    try {
      const phTableCheck = await client.query(
        `SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='openclaw' AND table_name='agent_pattern_history')`
      );
      if (phTableCheck.rows[0].exists) {
        let phBatch = 0;
        for (const ph of pHistory) {
          const newPatternId = patternMap[ph.pattern_id];
          if (!newPatternId) continue;
          await client.query(
            `INSERT INTO openclaw.agent_pattern_history (pattern_id, event_type, old_confidence, new_confidence, context, timestamp)
             VALUES ($1,$2,$3,$4,$5,$6)`,
            [newPatternId, ph.event_type, ph.old_confidence, ph.new_confidence, ph.context, ph.timestamp]
          );
          phBatch++;
          if (phBatch % 2000 === 0) console.log(`   ... ${phBatch}/${pHistory.length}`);
        }
        console.log(`   ✅ ${phBatch} pattern history migrated`);
      } else {
        console.log(`   ⚠️ agent_pattern_history table not found, skipping`);
      }
    } catch (e: any) {
      console.log(`   ⚠️ pattern_history skipped: ${e.message?.slice(0,80)}`);
    }

    // 8. Skill executions → agent_skill_executions (create if not exists)
    try {
      const seTableCheck = await client.query(
        `SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='openclaw' AND table_name='agent_skill_executions')`
      );
      if (seTableCheck.rows[0].exists) {
        const execs = sdb.prepare("SELECT * FROM skill_executions ORDER BY timestamp DESC LIMIT 500").all() as any[];
        console.log(`📦 Skill executions: ${execs.length} (last 500)`);
        for (const ex of execs) {
          await client.query(
            `INSERT INTO openclaw.agent_skill_executions (skill_id, summary, status, output_summary, session_key, duration_ms, timestamp)
             VALUES ($1,$2,$3,$4,$5,$6,$7)`,
            [ex.skill_id, ex.summary, ex.status, ex.output_summary, ex.session_key, ex.duration_ms, ex.timestamp]
          );
        }
        console.log(`   ✅ ${execs.length} executions migrated`);
      } else {
        console.log(`   ⚠️ agent_skill_executions not found, skipping`);
      }
    } catch (e: any) {
      console.log(`   ⚠️ executions skipped: ${e.message?.slice(0,80)}`);
    }

    await client.query("COMMIT");
    
    console.log("\n🎉 Migration complete!");
    console.log("\n📊 Summary:");
    console.log(`  Skills:              ${skills.length}`);
    console.log(`  Entries:             ${entries.length}`);
    console.log(`  Facts:               ${facts.length}`);
    console.log(`  Conversations:       ${convs.length}`);
    console.log(`  Patterns:            ${patterns.length}`);
    console.log(`  Pattern History:     ${pHistory.length}`);
    console.log(`\n⚠️ Embeddings (786) need re-embedding via Qwen3.`);
    console.log(`   HNSW binary not portable → entries will get fresh pgvector embeddings on first access.`);
    console.log(`\n✅ SQLite preserved at: ${SQLITE_PATH} (fallback)`);

  } catch (err) {
    await client.query("ROLLBACK");
    console.error("❌ Migration failed, rolled back:", err);
    throw err;
  } finally {
    client.release();
    await pool.end();
    sdb.close();
  }
}

migrate().catch((err) => {
  console.error(err);
  process.exit(1);
});
