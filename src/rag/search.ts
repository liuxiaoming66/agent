import { cosineSimilarity, embed, type EmbeddingFn } from "./embedding.js";
import type { VectorStore, VectorEntry, SearchResult } from "./vector-store.js";

const VECTOR_WEIGHT = 0.7;
const KEYWORD_WEIGHT = 0.3;
const CANDIDATE_MULTIPLIER = 4;

export async function hybridSearch(
  store: VectorStore,
  embedFn: EmbeddingFn,
  query: string,
  topK: number = 5,
): Promise<SearchResult[]> {
  const all = store.getAll();
  if (all.length === 0) return [];

  const candidateCount = Math.min(topK * CANDIDATE_MULTIPLIER, all.length);

  // 路径 1: 向量搜索
  const [queryVec] = await embed(embedFn, [query]);
  const vectorResults = all
    .map((entry: VectorEntry) => ({
      chunk: entry.chunk,
      score: cosineSimilarity(queryVec, entry.embedding),
    }))
    .sort((a: SearchResult, b: SearchResult) => b.score - a.score)
    .slice(0, candidateCount);

  // 路径 2: 关键词搜索 (BM25 倒排索引)
  const queryTerms = tokenize(query);
  const allTexts = all.map((e) => e.chunk.text);
  const bm25Index = buildBM25Index(allTexts);
  const keywordResults = all
    .map((entry: VectorEntry, i: number) => ({
      chunk: entry.chunk,
      score: bm25ScoreWithIndex(queryTerms, i, bm25Index),
    }))
    .sort((a: SearchResult, b: SearchResult) => b.score - a.score)
    .slice(0, candidateCount);

  // 归一化 + 合并
  const vectorScores = normalizeMinMax(vectorResults.map((r) => r.score));
  const keywordScores = normalizeMinMax(keywordResults.map((r) => r.score));

  const scoreMap = new Map<string, number>();
  vectorResults.forEach((r, i) => {
    const key = r.chunk.id;
    scoreMap.set(key, (scoreMap.get(key) ?? 0) + VECTOR_WEIGHT * vectorScores[i]);
  });
  keywordResults.forEach((r, i) => {
    const key = r.chunk.id;
    scoreMap.set(key, (scoreMap.get(key) ?? 0) + KEYWORD_WEIGHT * keywordScores[i]);
  });

  // 合并去重
  const combined: SearchResult[] = [];
  const seen = new Set<string>();
  for (const entry of all) {
    const score = scoreMap.get(entry.chunk.id) ?? 0;
    if (score > 0 && !seen.has(entry.chunk.id)) {
      combined.push({ chunk: entry.chunk, score });
      seen.add(entry.chunk.id);
    }
  }

  combined.sort((a, b) => b.score - a.score);
  return combined.slice(0, topK);
}

/** 分词：按空白分词并转小写 */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 0);
}

/** 预计算的 BM25 索引结构 */
interface BM25Index {
  /** 每篇文档的词频表: docIdx → Map<term, count> */
  docTermFreqs: Map<string, number>[];
  /** 倒排索引: term → 包含该词的文档下标集合 */
  invertedIndex: Map<string, Set<number>>;
  /** 每篇文档的 token 数 */
  docLengths: number[];
  /** 平均文档长度 */
  avgDocLen: number;
  /** 文档总数 */
  N: number;
}

/** 构建 BM25 索引（每次搜索前调用一次，避免重复 tokenize） */
function buildBM25Index(allDocs: string[]): BM25Index {
  const N = allDocs.length;
  const docTermFreqs: Map<string, number>[] = [];
  const invertedIndex = new Map<string, Set<number>>();
  const docLengths: number[] = [];

  for (let i = 0; i < N; i++) {
    const terms = tokenize(allDocs[i]);
    docLengths.push(terms.length);
    const freqMap = new Map<string, number>();
    for (const t of terms) {
      freqMap.set(t, (freqMap.get(t) ?? 0) + 1);
    }
    docTermFreqs.push(freqMap);
    // 构建倒排索引（每个词只记一次文档出现）
    for (const t of freqMap.keys()) {
      if (!invertedIndex.has(t)) invertedIndex.set(t, new Set());
      invertedIndex.get(t)!.add(i);
    }
  }

  const avgDocLen = docLengths.reduce((s, l) => s + l, 0) / (N || 1);
  return { docTermFreqs, invertedIndex, docLengths, avgDocLen, N };
}

/** BM25 评分（基于预计算索引，O(queryTerms) 复杂度） */
function bm25ScoreWithIndex(queryTerms: string[], docIdx: number, index: BM25Index): number {
  const k1 = 1.5;
  const b = 0.75;
  const { docTermFreqs, invertedIndex, docLengths, avgDocLen, N } = index;
  const docLen = docLengths[docIdx];
  const freqMap = docTermFreqs[docIdx];

  let score = 0;
  for (const term of queryTerms) {
    const tf = freqMap.get(term) ?? 0;
    if (tf === 0) continue;
    const df = invertedIndex.get(term)?.size ?? 0;
    const idf = Math.log((N - df + 0.5) / (df + 0.5) + 1);
    score += idf * ((tf * (k1 + 1)) / (tf + k1 * (1 - b + b * (docLen / avgDocLen))));
  }
  return score;
}

function normalizeMinMax(scores: number[]): number[] {
  if (scores.length === 0) return [];
  const min = Math.min(...scores);
  const max = Math.max(...scores);
  const range = max - min || 1;
  return scores.map((s) => (s - min) / range);
}

/** Jaccard 相似度（基于词集） */
function jaccardSimilarity(a: string, b: string): number {
  const setA = new Set(tokenize(a));
  const setB = new Set(tokenize(b));
  const intersection = new Set([...setA].filter((x) => setB.has(x)));
  const union = new Set([...setA, ...setB]);
  return union.size === 0 ? 0 : intersection.size / union.size;
}

const MMR_LAMBDA = 0.7; // 70% 看相关性，30% 看多样性

export function mmrSelect(results: SearchResult[], topK: number): SearchResult[] {
  if (results.length === 0) return [];
  const selected: SearchResult[] = [results[0]]; // 第一名直接入选
  const remaining = results.slice(1);

  while (selected.length < topK && remaining.length > 0) {
    let bestIdx = 0;
    let bestMmr = -Infinity;

    for (let i = 0; i < remaining.length; i++) {
      const relevance = remaining[i].score;
      const maxSim = Math.max(
        ...selected.map((s) => jaccardSimilarity(s.chunk.text, remaining[i].chunk.text)),
      );
      const mmr = MMR_LAMBDA * relevance - (1 - MMR_LAMBDA) * maxSim;
      if (mmr > bestMmr) {
        bestMmr = mmr;
        bestIdx = i;
      }
    }

    selected.push(remaining[bestIdx]);
    remaining.splice(bestIdx, 1);
  }

  return selected;
}
