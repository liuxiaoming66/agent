import { estimateTextTokens } from "../context/compressor.js";

export interface Chunk {
  id: string;
  text: string;
  source: string; // 来源文件
  index: number; // 在文档中的位置
  tokenEstimate: number;
}

const TARGET_TOKENS = 256;
const CHARS_PER_TOKEN = 4;
const TARGET_CHARS = TARGET_TOKENS * CHARS_PER_TOKEN;

function makeChunk(source: string, text: string, index: number): Chunk {
  return {
    id: `${source}#${index}`,
    text,
    source,
    index,
    tokenEstimate: estimateTextTokens(text),
  };
}

/** 按句子边界切分超长文本（句号、问号、感叹号、中文句号、中文问号、中文感叹号） */
function splitSentences(text: string): string[] {
  return text.split(/(?<=[.!?。！？])\s*/);
}

export function chunkDocument(source: string, text: string): Chunk[] {
  const paragraphs = text.split(/\n{2,}/);
  const chunks: Chunk[] = [];
  let current = "";
  let idx = 0;

  for (const para of paragraphs) {
    const trimmed = para.trim();
    if (!trimmed) continue;

    // 当前缓冲区 + 新段落超过目标大小，先把缓冲区存下来
    if (
      current.length + trimmed.length + 2 > TARGET_CHARS &&
      current.length > 0
    ) {
      chunks.push(makeChunk(source, current.trim(), idx++));
      current = "";
    }

    // 单个段落就超过目标大小，按句子边界切分
    if (trimmed.length > TARGET_CHARS) {
      const sentences = splitSentences(trimmed);
      for (const sent of sentences) {
        if (current.length + sent.length + 1 > TARGET_CHARS && current.length > 0) {
          chunks.push(makeChunk(source, current.trim(), idx++));
          current = "";
        }
        current += (current ? " " : "") + sent;
      }
    } else {
      current += (current ? "\n\n" : "") + trimmed;
    }
  }

  if (current.trim()) {
    chunks.push(makeChunk(source, current.trim(), idx++));
  }

  return chunks;
}
