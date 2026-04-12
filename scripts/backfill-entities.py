#!/usr/bin/env python3
"""
Backfill script: ekstrakcja encji i relacji z agent_knowledge + agent_entries
do tabel agent_entities, agent_entity_relations, agent_entity_mentions.

Używa Gemini 2.5 Flash do ekstrakcji i Qwen3-Embedding-8B do rozwiązywania aliasów.
"""

import json
import time
import sys
import math
import requests
import psycopg2
import psycopg2.extras

# --- Konfiguracja ---
DB_URL = "postgresql://openclaw:OpenClaw2026!@localhost:5432/openclaw_platform"
EMBED_URL = "http://localhost:8080/v1/embeddings"
EMBED_MODEL = "Qwen/Qwen3-Embedding-8B"
GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions"
GEMINI_KEY = "AIzaSyDVY10Z3KEoA3MWndSuJWiqFANaLei5Q1s"
GEMINI_MODEL = "gemini-2.5-flash"

ALIAS_SIMILARITY_THRESHOLD = 0.85
BATCH_SIZE = 10
MAX_RPS = 10  # max requests/sec do Gemini

# --- Liczniki ---
stats = {"entities": 0, "relations": 0, "mentions": 0, "skipped": 0}
request_times = []


def rate_limit():
    """Prosty rate limiter — max MAX_RPS żądań na sekundę."""
    now = time.time()
    request_times.append(now)
    # Usuń stare wpisy (starsze niż 1s)
    while request_times and request_times[0] < now - 1.0:
        request_times.pop(0)
    if len(request_times) >= MAX_RPS:
        sleep_time = 1.0 - (now - request_times[0])
        if sleep_time > 0:
            time.sleep(sleep_time)


def get_embedding(text: str) -> list[float]:
    """Pobierz embedding z Qwen3-Embedding-8B."""
    resp = requests.post(EMBED_URL, json={
        "model": EMBED_MODEL,
        "input": text[:7500]
    }, timeout=30)
    resp.raise_for_status()
    return resp.json()["data"][0]["embedding"]


def cosine_similarity(a: list[float], b: list[float]) -> float:
    """Cosine similarity dwóch wektorów."""
    dot = sum(x * y for x, y in zip(a, b))
    norm_a = math.sqrt(sum(x * x for x in a))
    norm_b = math.sqrt(sum(x * x for x in b))
    if norm_a == 0 or norm_b == 0:
        return 0.0
    return dot / (norm_a * norm_b)


def extract_entities_llm(text: str) -> dict:
    """Wywołaj Gemini do ekstrakcji encji i relacji z tekstu."""
    rate_limit()

    prompt = f"""Extract entities and relationships from the following text.
Return ONLY valid JSON (no markdown, no code fences) with this exact structure:
{{
  "entities": [
    {{"name": "Entity Name", "type": "person|organization|project|tool|infrastructure|concept", "aliases": ["alias1", "alias2"]}}
  ],
  "relations": [
    {{"source": "Entity A", "target": "Entity B", "type": "relation_type", "confidence": 0.9}}
  ]
}}

Entity types:
- person: people, users, agents (e.g. "Wiki", "Wiktoria Sterling", "Tank")
- organization: companies, teams (e.g. "Numerika AI", "OpenClaw")
- project: software projects, repos (e.g. "memory-unified", "mission-control")
- tool: software tools, models, services (e.g. "Qwen3-Embedding-8B", "PostgreSQL", "vis.js")
- infrastructure: servers, VMs, hardware (e.g. "RTX 3090", "Tank VM", "Loco39")
- concept: abstract concepts, methodologies (e.g. "RAG pipeline", "Ebbinghaus decay")

Relation types: uses, manages, deployed_on, part_of, created_by, depends_on, related_to, works_with, configured_with, runs_on

Text:
{text[:4000]}"""

    try:
        resp = requests.post(
            GEMINI_URL,
            headers={
                "Authorization": f"Bearer {GEMINI_KEY}",
                "Content-Type": "application/json"
            },
            json={
                "model": GEMINI_MODEL,
                "messages": [{"role": "user", "content": prompt}],
                "temperature": 0.1,
                "max_tokens": 2000
            },
            timeout=60
        )
        resp.raise_for_status()
        content = resp.json()["choices"][0]["message"]["content"]
        # Usuń ewentualne code fences
        content = content.strip()
        if content.startswith("```"):
            content = content.split("\n", 1)[1] if "\n" in content else content[3:]
        if content.endswith("```"):
            content = content[:-3]
        content = content.strip()
        if content.startswith("json"):
            content = content[4:].strip()
        return json.loads(content)
    except Exception as e:
        print(f"  [WARN] Gemini extraction failed: {e}")
        return {"entities": [], "relations": []}


def get_or_create_entity(cur, name: str, entity_type: str, aliases: list[str],
                          entity_cache: dict, embedding_cache: dict) -> int:
    """Znajdź istniejącą encję lub utwórz nową. Rozwiązywanie aliasów przez embeddingi."""
    # Sprawdź cache po nazwie (case-insensitive)
    name_lower = name.lower().strip()
    if name_lower in entity_cache:
        return entity_cache[name_lower]

    # Sprawdź w bazie
    cur.execute(
        "SELECT id, name, aliases FROM openclaw.agent_entities WHERE LOWER(name) = %s",
        (name_lower,)
    )
    row = cur.fetchone()
    if row:
        entity_cache[name_lower] = row[0]
        # Dodaj aliasy jeśli nowe
        existing_aliases = row[2] or []
        new_aliases = [a for a in aliases if a.lower() not in [x.lower() for x in existing_aliases]]
        if new_aliases:
            cur.execute(
                "UPDATE openclaw.agent_entities SET aliases = aliases || %s, updated_at = NOW() WHERE id = %s",
                (new_aliases, row[0])
            )
        return row[0]

    # Sprawdź aliasy istniejących encji przez embedding similarity
    if entity_cache:
        try:
            name_emb = embedding_cache.get(name_lower)
            if name_emb is None:
                name_emb = get_embedding(name)
                embedding_cache[name_lower] = name_emb

            best_match_id = None
            best_sim = 0.0
            for cached_name, cached_id in entity_cache.items():
                cached_emb = embedding_cache.get(cached_name)
                if cached_emb is None:
                    continue
                sim = cosine_similarity(name_emb, cached_emb)
                if sim > best_sim:
                    best_sim = sim
                    best_match_id = cached_id

            if best_sim >= ALIAS_SIMILARITY_THRESHOLD and best_match_id:
                # Dodaj jako alias
                cur.execute(
                    "UPDATE openclaw.agent_entities SET aliases = array_append(aliases, %s), updated_at = NOW() WHERE id = %s",
                    (name, best_match_id)
                )
                entity_cache[name_lower] = best_match_id
                return best_match_id
        except Exception as e:
            print(f"  [WARN] Alias matching failed for '{name}': {e}")

    # Utwórz nową encję
    cur.execute(
        """INSERT INTO openclaw.agent_entities (name, entity_type, aliases, metadata, created_at, updated_at)
           VALUES (%s, %s, %s, %s, NOW(), NOW()) RETURNING id""",
        (name, entity_type, aliases or [], json.dumps({"source": "backfill"}))
    )
    new_id = cur.fetchone()[0]
    entity_cache[name_lower] = new_id

    # Cache embedding
    try:
        if name_lower not in embedding_cache:
            embedding_cache[name_lower] = get_embedding(name)
    except Exception:
        pass

    stats["entities"] += 1
    return new_id


def create_relation(cur, source_id: int, target_id: int, relation_type: str,
                     confidence: float, relation_cache: set):
    """Utwórz relację między encjami (idempotent)."""
    key = (source_id, target_id, relation_type)
    if key in relation_cache:
        return
    cur.execute(
        """INSERT INTO openclaw.agent_entity_relations
           (source_entity_id, target_entity_id, relation_type, confidence, metadata, created_at)
           VALUES (%s, %s, %s, %s, %s, NOW())
           ON CONFLICT DO NOTHING""",
        (source_id, target_id, relation_type, confidence, json.dumps({"source": "backfill"}))
    )
    relation_cache.add(key)
    if cur.rowcount > 0:
        stats["relations"] += 1


def create_mention(cur, entity_id: int, entry_id: int | None, fact_id: int | None,
                    context: str, mention_cache: set):
    """Utwórz wzmiankę encji w entry/fact (idempotent)."""
    key = (entity_id, entry_id, fact_id)
    if key in mention_cache:
        return
    cur.execute(
        """INSERT INTO openclaw.agent_entity_mentions
           (entity_id, entry_id, fact_id, context_snippet, created_at)
           VALUES (%s, %s, %s, %s, NOW())""",
        (entity_id, entry_id, fact_id, context[:500] if context else "")
    )
    mention_cache.add(key)
    if cur.rowcount > 0:
        stats["mentions"] += 1


def process_text(cur, text: str, source_type: str, source_id: int,
                  entity_cache: dict, embedding_cache: dict,
                  relation_cache: set, mention_cache: set):
    """Przetwórz pojedynczy tekst — ekstrakcja encji i relacji."""
    if not text or len(text.strip()) < 10:
        stats["skipped"] += 1
        return

    result = extract_entities_llm(text)

    # Encje
    entity_ids = {}
    for ent in result.get("entities", []):
        ent_name = ent.get("name", "").strip()
        if not ent_name or len(ent_name) < 2:
            continue
        ent_type = ent.get("type", "concept")
        if ent_type not in ("person", "organization", "project", "tool", "infrastructure", "concept"):
            ent_type = "concept"
        aliases = [a.strip() for a in ent.get("aliases", []) if a.strip()]
        eid = get_or_create_entity(cur, ent_name, ent_type, aliases, entity_cache, embedding_cache)
        entity_ids[ent_name] = eid

        # Wzmianka
        entry_id = source_id if source_type == "entry" else None
        fact_id = source_id if source_type == "fact" else None
        create_mention(cur, eid, entry_id, fact_id, text[:300], mention_cache)

    # Relacje
    for rel in result.get("relations", []):
        src_name = rel.get("source", "").strip()
        tgt_name = rel.get("target", "").strip()
        rel_type = rel.get("type", "related_to")
        confidence = min(1.0, max(0.0, float(rel.get("confidence", 0.8))))

        src_id = entity_ids.get(src_name)
        tgt_id = entity_ids.get(tgt_name)
        if src_id and tgt_id and src_id != tgt_id:
            create_relation(cur, src_id, tgt_id, rel_type, confidence, relation_cache)


def main():
    print("=" * 60)
    print("Memory Graph Backfill — Entity & Relation Extraction")
    print("=" * 60)

    conn = psycopg2.connect(DB_URL)
    conn.autocommit = False
    cur = conn.cursor()

    # Cache istniejących encji
    entity_cache = {}
    embedding_cache = {}
    relation_cache = set()
    mention_cache = set()

    cur.execute("SELECT id, name FROM openclaw.agent_entities")
    for row in cur.fetchall():
        entity_cache[row[1].lower()] = row[0]
    print(f"Loaded {len(entity_cache)} existing entities")

    # Załaduj istniejące relacje
    cur.execute("SELECT source_entity_id, target_entity_id, relation_type FROM openclaw.agent_entity_relations")
    for row in cur.fetchall():
        relation_cache.add((row[0], row[1], row[2]))
    print(f"Loaded {len(relation_cache)} existing relations")

    # Załaduj istniejące wzmianki
    cur.execute("SELECT entity_id, entry_id, fact_id FROM openclaw.agent_entity_mentions")
    for row in cur.fetchall():
        mention_cache.add((row[0], row[1], row[2]))
    print(f"Loaded {len(mention_cache)} existing mentions")

    # --- Fakty (agent_knowledge) ---
    cur.execute(
        "SELECT id, topic, fact, category FROM openclaw.agent_knowledge WHERE status = 'active' ORDER BY id"
    )
    facts = cur.fetchall()
    total_facts = len(facts)
    print(f"\nProcessing {total_facts} active facts...")

    for i in range(0, total_facts, BATCH_SIZE):
        batch = facts[i:i + BATCH_SIZE]
        for fact_id, topic, fact_text, category in batch:
            text = f"[{topic}] {fact_text}" if topic else fact_text
            process_text(cur, text, "fact", fact_id,
                        entity_cache, embedding_cache, relation_cache, mention_cache)
        conn.commit()
        processed = min(i + BATCH_SIZE, total_facts)
        print(f"  Facts: {processed}/{total_facts} — entities: {stats['entities']}, relations: {stats['relations']}")

    # --- Wpisy (agent_entries) ---
    cur.execute(
        """SELECT id, entry_type, content, summary
           FROM openclaw.agent_entries
           WHERE entry_type IN ('skill', 'protocol', 'config', 'task', 'result', 'file')
           ORDER BY id"""
    )
    entries = cur.fetchall()
    total_entries = len(entries)
    print(f"\nProcessing {total_entries} entries (skill/protocol/config/task/result/file)...")

    for i in range(0, total_entries, BATCH_SIZE):
        batch = entries[i:i + BATCH_SIZE]
        for entry_id, entry_type, content, summary in batch:
            text = summary if summary and len(summary) > 20 else content
            if text:
                text = f"[{entry_type}] {text}"
            process_text(cur, text, "entry", entry_id,
                        entity_cache, embedding_cache, relation_cache, mention_cache)
        conn.commit()
        processed = min(i + BATCH_SIZE, total_entries)
        print(f"  Entries: {processed}/{total_entries} — entities: {stats['entities']}, relations: {stats['relations']}")

    # --- Podsumowanie ---
    cur.execute("SELECT count(*) FROM openclaw.agent_entities")
    total_entities = cur.fetchone()[0]
    cur.execute("SELECT count(*) FROM openclaw.agent_entity_relations")
    total_relations = cur.fetchone()[0]
    cur.execute("SELECT count(*) FROM openclaw.agent_entity_mentions")
    total_mentions = cur.fetchone()[0]

    conn.commit()
    cur.close()
    conn.close()

    print("\n" + "=" * 60)
    print("BACKFILL COMPLETE")
    print("=" * 60)
    print(f"New entities created:  {stats['entities']}")
    print(f"New relations created: {stats['relations']}")
    print(f"New mentions created:  {stats['mentions']}")
    print(f"Skipped (too short):   {stats['skipped']}")
    print(f"\nTotal in DB:")
    print(f"  Entities:  {total_entities}")
    print(f"  Relations: {total_relations}")
    print(f"  Mentions:  {total_mentions}")


if __name__ == "__main__":
    main()
