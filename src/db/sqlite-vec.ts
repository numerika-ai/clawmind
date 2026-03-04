/**
 * db/sqlite-vec.ts — sqlite-vec vector store (vec0 virtual table)
 *
 * Stores 4096-dim Qwen3 embeddings in the same SQLite database file
 * as unified_entries. Uses cosine distance for KNN search.
 *
 * Phase 1: dual-write alongside LanceDB (writes only, reads stay on LanceDB).
 * Phase 2: becomes the primary vector search backend.
 */

import * as sqliteVec from "sqlite-vec";
import type Database from "better-sqlite3";

export class SqliteVecStore {
    constructor(private db: Database.Database, private logger: any) {
        // Load sqlite-vec extension into the existing better-sqlite3 connection
        sqliteVec.load(db);
        this.initTable();
    }

    private initTable(): void {
        this.db.exec(`
            CREATE VIRTUAL TABLE IF NOT EXISTS vec_entries USING vec0(
                entry_id INTEGER PRIMARY KEY,
                embedding float[4096] distance_metric=cosine,
                entry_type TEXT,
                +text TEXT
            );
        `);
    }

    store(entryId: number, text: string, embedding: number[], entryType: string): boolean {
        try {
            // Delete existing if present (upsert pattern)
            this.db.prepare("DELETE FROM vec_entries WHERE entry_id = ?").run(entryId);
            this.db.prepare(
                "INSERT INTO vec_entries (entry_id, embedding, entry_type, text) VALUES (?, ?, ?, ?)"
            ).run(entryId, new Float32Array(embedding), entryType, text.slice(0, 500));
            return true;
        } catch (err) {
            this.logger.warn?.("sqlite-vec store failed:", String(err));
            return false;
        }
    }

    search(queryEmbedding: number[], topK = 5, entryType?: string): Array<{ entryId: number; distance: number }> {
        try {
            const vec = new Float32Array(queryEmbedding);
            let sql: string;
            let params: any[];
            if (entryType) {
                sql = "SELECT entry_id, distance FROM vec_entries WHERE embedding MATCH ? AND k = ? AND entry_type = ?";
                params = [vec, topK, entryType];
            } else {
                sql = "SELECT entry_id, distance FROM vec_entries WHERE embedding MATCH ? AND k = ?";
                params = [vec, topK];
            }
            const rows = this.db.prepare(sql).all(...params) as any[];
            return rows.map(r => ({ entryId: r.entry_id, distance: r.distance }));
        } catch (err) {
            this.logger.warn?.("sqlite-vec search failed:", String(err));
            return [];
        }
    }

    delete(entryId: number): boolean {
        try {
            this.db.prepare("DELETE FROM vec_entries WHERE entry_id = ?").run(entryId);
            return true;
        } catch {
            return false;
        }
    }

    count(): number {
        try {
            const r = this.db.prepare("SELECT COUNT(*) as count FROM vec_entries").get() as any;
            return r?.count ?? 0;
        } catch {
            return 0;
        }
    }
}
