import { ModelMessage } from "ai";

export class TokenTracker {
  private lastPreciseCount = 0; // 上次 API 返回的精确值
  private pendingChars = 0; // 新增消息的字符数

  updateFromAPI(promptTokens: number): void {
    this.lastPreciseCount = promptTokens;
    this.pendingChars = 0; // 精确值到了，清零增量
  }

  addMessage(content: string): void {
    this.pendingChars += content.length;
  }

  get estimatedTokens(): number {
    return this.lastPreciseCount + Math.ceil(this.pendingChars / 4);
  }
}

export function estimateMessageTokens(messages: ModelMessage[]): number {
  let chars = 0;
  for (const msg of messages) {
    if (typeof msg.content === "string") {
      chars += msg.content.length;
    } else if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part.type === "text") {
          chars += (part as { text: string }).text.length;
        } else if (part.type === "tool-call") {
          chars += JSON.stringify(part).length;
        } else if (part.type === "tool-result") {
          chars += JSON.stringify(part).length;
        }
      }
    }
  }
  return Math.ceil((chars / 4) * 1.2); // 1.2x 中文安全系数
}

const CONTEXT_WINDOW = 200_000;

export function truncateToolResults(
  messages: ModelMessage[],
  config = {
    maxSingleResult: CONTEXT_WINDOW * 0.5 * 2, // 50% 窗口，2 chars/token
    contextBudgetChars: CONTEXT_WINDOW * 0.75 * 4, // 75% 窗口，4 chars/token
  },
): { messages: ModelMessage[]; truncated: number; compacted: number } {
  let truncated = 0;
  let compacted = 0;

  // Pass 1: 单条截断——超过窗口 50% 的工具结果做 Head/Tail 分割
  let result = messages.map((msg) => {
    if (msg.role !== "tool") return msg;
    const newContent = msg.content.map((part: any) => {
      if (part.type !== "tool-result") return part;
      const text = extractOutputText(part);
      if (text.length <= config.maxSingleResult) return part;
      truncated++;
      const maxChars = config.maxSingleResult;
      const head = text.slice(0, Math.floor(maxChars * 0.6));
      const tail = text.slice(-Math.floor(maxChars * 0.4));
      return {
        ...part,
        output: {
          type: "text" as const,
          value: `${head}\n\n[truncated: ${text.length} → ${maxChars} chars]\n\n${tail}`,
        },
      };
    });
    return { ...msg, content: newContent };
  });

  // Pass 2: 总量预算——如果总字符数还超 75%，从最老的 tool result 开始清理
  let totalChars = result.reduce((sum, msg) => {
    if (typeof msg.content === "string") return sum + msg.content.length;
    if (Array.isArray(msg.content)) {
      return (
        sum +
        msg.content.reduce(
          (s: number, p: any) => s + extractOutputText(p).length + ((p as any).text?.length || 0),
          0,
        )
      );
    }
    return sum;
  }, 0);

  if (totalChars > config.contextBudgetChars) {
    for (
      let i = 0;
      i < result.length && totalChars > config.contextBudgetChars;
      i++
    ) {
      const msg = result[i];
      if (msg.role !== "tool" || !Array.isArray(msg.content)) continue;
      const toolName = (msg.content[0] as any)?.toolName || "unknown";
      const oldSize = msg.content.reduce(
        (s: number, p: any) => s + extractOutputText(p).length,
        0,
      );
      result[i] = {
        ...msg,
        content: msg.content.map((p: any) =>
          p.type === "tool-result"
            ? {
                ...p,
                output: {
                  type: "text" as const,
                  value: `[compacted: ${toolName} output removed to free context]`,
                },
              }
            : p,
        ),
      };
      totalChars -= oldSize;
      compacted++;
    }
  }

  return { messages: result, truncated, compacted };
}

// ============ TTL Prune ============

export interface PruneResult {
  messages: ModelMessage[];
  softPruned: number;
  hardPruned: number;
}

/** 提取 tool-result part 中的文本内容（兼容 ToolResultOutput 联合类型） */
function extractOutputText(part: any): string {
  if (!part.output) return "";
  if (typeof part.output === "string") return part.output;
  if (typeof part.output === "object" && "value" in part.output) {
    return typeof part.output.value === "string"
      ? part.output.value
      : JSON.stringify(part.output.value);
  }
  return JSON.stringify(part.output);
}

/** soft prune：保留 head + tail 字符，中间替换为占位符 */
function softPruneMessage(msg: ModelMessage, keepChars = 500): ModelMessage {
  if (msg.role !== "tool") return msg;
  const headKeep = Math.floor(keepChars * 0.6);
  const tailKeep = Math.floor(keepChars * 0.4);

  return {
    ...msg,
    content: msg.content.map((part: any) => {
      if (part.type !== "tool-result") return part;
      const text = extractOutputText(part);
      if (text.length <= keepChars) return part;
      const head = text.slice(0, headKeep);
      const tail = text.slice(-tailKeep);
      return {
        ...part,
        output: {
          type: "text" as const,
          value: `${head}\n\n[soft-pruned: ${text.length} → ${keepChars} chars]\n\n${tail}`,
        },
      };
    }),
  };
}

export function ttlPrune(
  messages: ModelMessage[],
  timestamps: Map<number, number>, // 消息索引 → 创建时间戳
  config = {
    softTTLMs: 5 * 60_000,
    hardTTLMs: 10 * 60_000,
    keepHeadTail: 500,
  },
): PruneResult {
  const now = Date.now();
  let softPruned = 0,
    hardPruned = 0;

  const result = messages.map((msg, idx) => {
    // 只修剪 tool 结果，user/assistant 消息永不修剪
    if (msg.role !== "tool") return msg;

    const age = now - (timestamps.get(idx) || now);

    // 保留错误经验——失败的工具结果永不修剪
    const outputText = msg.content
      .map((p: any) => extractOutputText(p))
      .join("");
    if (/error|失败|不存在|denied|timeout/i.test(outputText)) return msg;

    if (age >= config.hardTTLMs) {
      hardPruned++;
      return {
        ...msg,
        content: msg.content.map((part: any) =>
          part.type === "tool-result"
            ? { ...part, output: { type: "text" as const, value: "[tool result expired]" } }
            : part,
        ),
      };
    }

    if (age >= config.softTTLMs) {
      softPruned++;
      return softPruneMessage(msg, config.keepHeadTail);
    }

    return msg;
  });

  return { messages: result, softPruned, hardPruned };
}

// ============ 统一防线入口 ============

export interface DefenseResult {
  messages: ModelMessage[];
  truncated: number;
  compacted: number;
  softPruned: number;
  hardPruned: number;
  tokenEstimate: number;
}

/**
 * 每轮对话前执行的统一防线：
 * Layer 2: 截断超长工具结果 + 总量预算清理
 * Layer 3: TTL 软修剪 / 硬清除
 * 最后估算当前 token 数
 */
export function applyDefense(
  messages: ModelMessage[],
  timestamps: Map<number, number>,
): DefenseResult {
  // Layer 2: 截断
  const trunc = truncateToolResults(messages);

  // Layer 3: TTL 修剪
  const prune = ttlPrune(trunc.messages, timestamps);

  // Token 估算
  const tokenEstimate = estimateMessageTokens(prune.messages);

  return {
    messages: prune.messages,
    truncated: trunc.truncated,
    compacted: trunc.compacted,
    softPruned: prune.softPruned,
    hardPruned: prune.hardPruned,
    tokenEstimate,
  };
}
