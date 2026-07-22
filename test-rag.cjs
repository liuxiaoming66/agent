const Database = require('better-sqlite3');
const sv = require('sqlite-vec');
const db = new Database('.rag/knowledge.db');
sv.load(db);

// 测试 vectorSearch 的完整 JOIN（子查询方式）
try {
  const emb = Buffer.from(new Float32Array(128).fill(0.01).buffer);
  const rows = db.prepare(`
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
  `).all(emb, 5);
  console.log('vectorSearch JOIN OK:', rows.length, 'results');
  if (rows.length > 0) console.log('  first:', rows[0].chunk_id, 'dist:', rows[0].distance);
} catch(e) { console.log('vectorSearch JOIN ERROR:', e.message); }

// 测试 keywordSearch 的完整 JOIN
try {
  const rows = db.prepare(`
    SELECT f.id, bm25(chunks_fts) AS rank, c.text, c.source, c.chunk_index
    FROM chunks_fts f
    JOIN chunks c ON c.id = f.id
    WHERE chunks_fts MATCH ?
    ORDER BY rank
    LIMIT ?
  `).all('Agent 主循环', 5);
  console.log('keywordSearch JOIN OK:', rows.length, 'results');
} catch(e) { console.log('keywordSearch JOIN ERROR:', e.message); }

// 测试带特殊字符的 FTS5 查询
const testQueries = ['Agent 主循环运行机制', '工具系统', 'RAG', '记忆系统'];
for (const q of testQueries) {
  try {
    const rows = db.prepare('SELECT id FROM chunks_fts WHERE chunks_fts MATCH ? LIMIT 3').all(q);
    console.log(`FTS "${q}" OK:`, rows.length, 'results');
  } catch(e) { console.log(`FTS "${q}" ERROR:`, e.message); }
}

db.close();
