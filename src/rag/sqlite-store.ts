import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import fs from "node:fs";
import path from "node:path";
import type { Chunk } from "./chunker.js";
import { embed, type EmbeddingFn } from "./embedding.js";
import { mmrSelect } from "./search.js";
import type { SearchResult } from "./vector-store.js";

/** 扩展搜索结果，携带向量/关键词分项得分（用于混合加权） */
interface ScoredResult extends SearchResult {
  vectorScore: number;
  keywordScore: number;
}

export class SqliteVectorStore {
  private db: Database.Database;

  constructor(dbPath: string = ".rag/knowledge.db") {
    // 确保数据库文件目录存在
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    this.db = new Database(dbPath);
    sqliteVec.load(this.db); // 加载向量搜索扩展
    this.createTables();
    this.migrateIfNeeded();
  }

  private createTables() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chunks (
        id TEXT PRIMARY KEY,
        text TEXT NOT NULL,
        source TEXT NOT NULL,
        chunk_index INTEGER NOT NULL,
        embedding BLOB NOT NULL,
        model TEXT NOT NULL DEFAULT 'text-embedding-v3',
        updated_at INTEGER NOT NULL
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS chunks_vec USING vec0(
        embedding FLOAT[128]
      );

      CREATE TABLE IF NOT EXISTS chunks_vec_map (
        chunk_id TEXT PRIMARY KEY,
        vec_rowid INTEGER NOT NULL
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
        text, id UNINDEXED, source UNINDEXED
      );
    `);
  }

  /**
   * 迁移：如果 chunks_vec_map 为空但 chunks 有数据（旧代码导入的），
   * 重建 vec0 和映射表。
   */
  private migrateIfNeeded(): void {
    const mapCount = (
      this.db.prepare("SELECT COUNT(*) as n FROM chunks_vec_map").get() as any
    ).n;
    if (mapCount > 0) return; // 映射表已有数据，无需迁移

    const chunkCount = (
      this.db.prepare("SELECT COUNT(*) as n FROM chunks").get() as any
    ).n;
    if (chunkCount === 0) return; // 没有数据，无需迁移

    // 旧数据库有 chunks 数据但映射表为空，重建 vec0 + 映射表
    console.log(`[RAG] 检测到 ${chunkCount} 条旧数据，重建向量索引...`);
    this.db.exec("DROP TABLE IF EXISTS chunks_vec;");
    this.db.exec(`
      CREATE VIRTUAL TABLE chunks_vec USING vec0(
        embedding FLOAT[128]
      );
    `);

    const rows = this.db
      .prepare("SELECT id, embedding FROM chunks")
      .all() as any[];

    const insertVec = this.db.prepare(
      "INSERT INTO chunks_vec (embedding) VALUES (?)",
    );
    const insertMap = this.db.prepare(
      "INSERT INTO chunks_vec_map (chunk_id, vec_rowid) VALUES (?, ?)",
    );

    const tx = this.db.transaction(() => {
      for (const r of rows) {
        insertVec.run(r.embedding);
        const rid = (
          this.db.prepare("SELECT MAX(rowid) as m FROM chunks_vec").get() as any
        ).m;
        insertMap.run(r.id, rid);
      }
    });
    tx();
    console.log(`[RAG] 向量索引重建完成，已迁移 ${rows.length} 条记录`);
  }

  add(chunk: Chunk, embedding: number[]): void {
    const now = Date.now();
    const embBlob = Buffer.from(new Float32Array(embedding).buffer);

    // 1. 写入 chunks 主表
    this.db
      .prepare(
        `INSERT OR REPLACE INTO chunks
      (id, text, source, chunk_index, embedding, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(chunk.id, chunk.text, chunk.source, chunk.index, embBlob, now);

    // 2. 写入 vec0（自动分配 rowid），通过映射表关联
    //    先清理旧映射（重复导入场景）
    const oldMap = this.db
      .prepare("SELECT vec_rowid FROM chunks_vec_map WHERE chunk_id = ?")
      .get(chunk.id) as { vec_rowid: number } | undefined;
    if (oldMap) {
      this.db
        .prepare("DELETE FROM chunks_vec WHERE rowid = ?")
        .run(oldMap.vec_rowid);
      this.db
        .prepare("DELETE FROM chunks_vec_map WHERE chunk_id = ?")
        .run(chunk.id);
    }

    // 插入 vec0，让 sqlite-vec 自动分配 rowid
    this.db
      .prepare("INSERT INTO chunks_vec (embedding) VALUES (?)")
      .run(embBlob);
    // 用 MAX(rowid) 获取刚插入的 vec0 rowid（比 last_insert_rowid 更可靠）
    const vecRowid = (
      this.db.prepare("SELECT MAX(rowid) as m FROM chunks_vec").get() as any
    ).m;

    // 存储映射关系
    this.db
      .prepare(
        "INSERT INTO chunks_vec_map (chunk_id, vec_rowid) VALUES (?, ?)",
      )
      .run(chunk.id, vecRowid);

    // 3. 写入 FTS5 全文索引
    this.db
      .prepare(
        `INSERT OR REPLACE INTO chunks_fts (id, text, source)
      VALUES (?, ?, ?)`,
      )
      .run(chunk.id, chunk.text, chunk.source);
  }

  addBatch(items: Array<{ chunk: Chunk; embedding: number[] }>): void {
    const tx = this.db.transaction(() => {
      for (const { chunk, embedding } of items) this.add(chunk, embedding);
    });
    tx(); // 事务批量写入，比逐条快很多
  }

  vectorSearch(
    queryEmbedding: number[],
    topK: number,
  ): Array<{ chunk: Chunk; score: number }> {
    const buf = Buffer.from(new Float32Array(queryEmbedding).buffer);
    // vec0 KNN 要求 LIMIT 直接在子查询内，不能放在外层 JOIN 后
    const rows = this.db
      .prepare(
        `
      SELECT v.rowid, v.distance, m.chunk_id, c.text, c.source, c.chunk_index
      FROM (
        SELECT rowid, distance
        FROM chunks_vec
        WHERE embedding MATCH ?
        LIMIT ?
      ) v
      JOIN chunks_vec_map m ON m.vec_rowid = v.rowid
      JOIN chunks c ON c.id = m.chunk_id
      ORDER BY v.distance
    `,
      )
      .all(buf, topK) as any[];

    return rows.map((r) => ({
      chunk: {
        id: r.chunk_id,
        text: r.text,
        source: r.source,
        index: r.chunk_index,
        tokenEstimate: Math.ceil(r.text.length / 4),
      },
      score: 1 - r.distance, // cosine distance → similarity
    }));
  }

  keywordSearch(
    query: string,
    topK: number,
  ): Array<{ chunk: Chunk; score: number }> {
    const rows = this.db
      .prepare(
        `
      SELECT f.id, bm25(chunks_fts) AS rank, c.text, c.source, c.chunk_index
      FROM chunks_fts f
      JOIN chunks c ON c.id = f.id
      WHERE chunks_fts MATCH ?
      ORDER BY rank
      LIMIT ?
    `,
      )
      .all(query, topK) as any[];

    return rows.map((r) => ({
      chunk: {
        id: r.id,
        text: r.text,
        source: r.source,
        index: r.chunk_index,
        tokenEstimate: Math.ceil(r.text.length / 4),
      },
      score: r.rank < 0 ? -r.rank / (1 - r.rank) : 1 / (1 + r.rank),
    }));
  }

  size(): number {
    return (this.db.prepare("SELECT COUNT(*) as n FROM chunks").get() as any).n;
  }

  clear(): void {
    this.db.exec(`
      DELETE FROM chunks;
      DELETE FROM chunks_vec_map;
      DELETE FROM chunks_fts;
    `);
    // vec0 不支持 DELETE FROM 全表，需 DROP 重建
    this.db.exec("DROP TABLE IF EXISTS chunks_vec;");
    this.db.exec(`
      CREATE VIRTUAL TABLE chunks_vec USING vec0(
        embedding FLOAT[128]
      );
    `);
  }

  sources(): string[] {
    return (
      this.db.prepare("SELECT DISTINCT source FROM chunks").all() as any[]
    ).map((r) => r.source);
  }

  deleteBySource(source: string): number {
    const ids = (
      this.db
        .prepare("SELECT id FROM chunks WHERE source = ?")
        .all(source) as any[]
    ).map((r) => r.id);
    if (ids.length === 0) return 0;

    const tx = this.db.transaction(() => {
      for (const id of ids) {
        // 删除 vec0 中对应的向量
        const map = this.db
          .prepare("SELECT vec_rowid FROM chunks_vec_map WHERE chunk_id = ?")
          .get(id) as { vec_rowid: number } | undefined;
        if (map) {
          this.db
            .prepare("DELETE FROM chunks_vec WHERE rowid = ?")
            .run(map.vec_rowid);
          this.db
            .prepare("DELETE FROM chunks_vec_map WHERE chunk_id = ?")
            .run(id);
        }
        // 删除主表和 FTS
        this.db.prepare("DELETE FROM chunks WHERE id = ?").run(id);
        this.db.prepare("DELETE FROM chunks_fts WHERE id = ?").run(id);
      }
    });
    tx();
    return ids.length;
  }

  /** 混合搜索：在 SQLite 层完成向量 + 关键词双路检索 */
  async hybridSearch(
    embedFn: EmbeddingFn,
    query: string,
    topK: number = 5,
  ): Promise<SearchResult[]> {
    const candidateCount = Math.min(topK * 4, this.size());
    if (candidateCount === 0) return [];

    const [queryVec] = await embed(embedFn, [query]);

    // 路径 1: sqlite-vec 向量搜索
    const vectorResults = this.vectorSearch(queryVec, candidateCount);

    // 路径 2: FTS5 关键词搜索
    const keywordResults = this.keywordSearch(query, candidateCount);

    // 归一化 + 加权合并
    const vecScores = normalizeMinMax(vectorResults.map((r) => r.score));
    const kwScores = normalizeMinMax(keywordResults.map((r) => r.score));

    const candidates = new Map<string, ScoredResult>();
    for (let i = 0; i < vectorResults.length; i++) {
      const id = vectorResults[i].chunk.id;
      candidates.set(id, {
        chunk: vectorResults[i].chunk,
        score: vecScores[i] * 0.7,
        vectorScore: vecScores[i],
        keywordScore: 0,
      });
    }
    for (let i = 0; i < keywordResults.length; i++) {
      const id = keywordResults[i].chunk.id;
      const existing = candidates.get(id);
      if (existing) {
        existing.keywordScore = kwScores[i];
        existing.score += kwScores[i] * 0.3;
      } else {
        candidates.set(id, {
          chunk: keywordResults[i].chunk,
          score: kwScores[i] * 0.3,
          vectorScore: 0,
          keywordScore: kwScores[i],
        });
      }
    }

    const sorted = [...candidates.values()].sort((a, b) => b.score - a.score);

    // MMR 去重，保证结果多样性
    return mmrSelect(sorted, topK);
  }

  /** 关闭数据库连接 */
  close(): void {
    this.db.close();
  }
}

function normalizeMinMax(scores: number[]): number[] {
  if (scores.length === 0) return [];
  const min = Math.min(...scores);
  const max = Math.max(...scores);
  const range = max - min || 1;
  return scores.map((s) => (s - min) / range);
}
