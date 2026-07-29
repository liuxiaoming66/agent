import type { Chunk } from "./chunker.js";

/** 带向量嵌入的文档片段 */
export interface VectorEntry {
  chunk: Chunk;
  embedding: number[];
}

/** 搜索结果：片段 + 综合得分 */
export interface SearchResult {
  chunk: Chunk;
  score: number;
}

/**
 * 内存向量存储：存储文档片段及其嵌入向量，
 * 支持批量写入、来源查询和全量遍历。
 */
export class VectorStore {
  private entries: VectorEntry[] = [];
  private sourceSet = new Set<string>();

  addBatch(batch: VectorEntry[]): void {
    for (const entry of batch) {
      this.entries.push(entry);
      this.sourceSet.add(entry.chunk.source);
    }
  }

  getAll(): VectorEntry[] {
    return this.entries;
  }

  size(): number {
    return this.entries.length;
  }

  sources(): string[] {
    return Array.from(this.sourceSet);
  }

  clear(): void {
    this.entries = [];
    this.sourceSet.clear();
  }
}
