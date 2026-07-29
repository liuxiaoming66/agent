export type EmbeddingFn = (texts: string[]) => Promise<number[][]>;

/** Mock 嵌入：生成确定性伪向量（用于本地测试） */
function mockEmbed(text: string): number[] {
  const dim = 128;
  const vec: number[] = new Array(dim).fill(0);
  for (let i = 0; i < text.length && i < dim; i++) {
    vec[i % dim] += text.charCodeAt(i) / 255;
  }
  // 归一化
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
  return vec.map((v) => v / norm);
}

export function createMockEmbedder(): EmbeddingFn {
  return async (texts: string[]) => texts.map(mockEmbed);
}

export function createDashScopeEmbedder(apiKey: string): EmbeddingFn {
  return async (texts: string[]) => {
    const resp = await fetch(
      "https://dashscope.aliyuncs.com/compatible-mode/v1/embeddings",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "text-embedding-v3",
          input: texts,
          dimensions: 128,
        }),
      },
    );
    const data = (await resp.json()) as any;
    return data.data.map((d: any) => d.embedding as number[]);
  };
}
const embedCache = new Map<string, number[]>();

export async function embed(
  fn: EmbeddingFn,
  texts: string[],
): Promise<number[][]> {
  const results: number[][] = new Array(texts.length);
  const uncached: { idx: number; text: string }[] = [];

  for (let i = 0; i < texts.length; i++) {
    const cached = embedCache.get(texts[i]);
    if (cached) {
      results[i] = cached;
    } else {
      uncached.push({ idx: i, text: texts[i] });
    }
  }

  if (uncached.length > 0) {
    const vectors = await fn(uncached.map((u) => u.text));
    for (let i = 0; i < uncached.length; i++) {
      results[uncached[i].idx] = vectors[i];
      embedCache.set(uncached[i].text, vectors[i]);
    }
  }

  return results;
}
export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0,
    normA = 0,
    normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB) || 1);
}
