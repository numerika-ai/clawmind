/**
 * db/lance-manager.ts — Vector index manager (sqlite-vec only)
 *
 * Wraps SqliteVecStore with SQLite hnsw_meta tracking,
 * Nemotron embedding, and bulk indexing.
 */
import Database from "better-sqlite3";
import type { SqliteVecStore } from "./sqlite-vec";
export declare class VectorManager {
    private sqliteVecStore;
    private insertsSinceSave;
    private db;
    private logger;
    constructor(db: ReturnType<typeof Database>, sqliteVecStore: SqliteVecStore, logger: any);
    isReady(): boolean;
    getCount(): number;
    /** Embed text and add to sqlite-vec index with the given unified_entries.id as label */
    addEntry(entryId: number, text: string): Promise<boolean>;
    /** Search for entries most similar to query text via sqlite-vec */
    search(query: string, topK?: number, excludeTypes?: string[]): Promise<Array<{
        entryId: number;
        distance: number;
    }>>;
    /** No-op — sqlite-vec auto-persists via SQLite WAL */
    save(): void;
    /** Bulk-index entries missing from sqlite-vec (incremental — only embeds what's missing) */
    bulkIndex(): Promise<void>;
}
export { VectorManager as NativeLanceManager };
//# sourceMappingURL=lance-manager.d.ts.map