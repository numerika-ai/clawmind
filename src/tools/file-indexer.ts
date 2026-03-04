/**
 * tools/file-indexer.ts — Scan and index files into unified memory
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { Type } from "@sinclair/typebox";
import type { ToolDef, ToolResult, UnifiedDB } from "../types";

const DEFAULT_WORKSPACE = "/home/tank/.openclaw/workspace";
const INDEXABLE_EXTENSIONS = ['.md', '.txt', '.json', '.ts', '.py', '.sh'];

export function createUnifiedIndexFilesTool(udb: UnifiedDB): ToolDef {
  return {
    name: "unified_index_files",
    label: "Index Files",
    description: "Scan a directory and index files into unified memory",
    parameters: Type.Object({
      directory: Type.Optional(Type.String({
        description: "Directory to scan (default: workspace)",
        default: DEFAULT_WORKSPACE
      })),
      limit: Type.Optional(Type.Number({
        description: "Maximum number of files to process (default: 100)",
        default: 100
      })),
    }),
    async execute(_id, params): Promise<ToolResult> {
      const directory = params.directory as string || DEFAULT_WORKSPACE;
      const limit = params.limit as number || 100;

      let processed = 0;
      let skipped = 0;

      try {
        const entries = fs.readdirSync(directory, { withFileTypes: true });

        for (const entry of entries) {
          if (processed >= limit) break;

          if (entry.isFile()) {
            const filePath = path.join(directory, entry.name);
            const ext = path.extname(entry.name).toLowerCase();

            if (INDEXABLE_EXTENSIONS.includes(ext)) {
              // Check if already indexed
              const existing = udb.searchEntries("file").find(
                (e: any) => e.source_path === filePath
              );

              if (existing) {
                skipped++;
                continue;
              }

              // Read and index file
              try {
                const content = fs.readFileSync(filePath, 'utf-8').slice(0, 2000);
                const relativePath = path.relative(DEFAULT_WORKSPACE, filePath);

                // Generate tags from path
                const pathParts = relativePath.split('/').filter(p => p.length > 0);
                const tags = pathParts.map(part =>
                  part.replace(/\.(md|txt|json|ts|py|sh)$/, '')
                       .replace(/[^a-zA-Z0-9]/g, '-')
                       .toLowerCase()
                ).join(',');

                udb.storeEntry({
                  entryType: "file",
                  content,
                  tags,
                  sourcePath: filePath,
                  summary: `File: ${entry.name} (${content.length} chars)`
                });

                processed++;
              } catch (readError) {
                // Skip files that can't be read
                skipped++;
              }
            }
          }
        }

        return {
          content: [{ type: "text", text: `Indexed ${processed} files, skipped ${skipped} files from ${directory}` }],
          details: { processed, skipped, directory }
        };

      } catch (error) {
        return {
          content: [{ type: "text", text: `Failed to scan directory ${directory}: ${error}` }],
        };
      }
    },
  };
}
