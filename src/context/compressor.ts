import { generateText, LanguageModel, ModelMessage } from "ai";

const CLEARABLE_TOOLS = new Set([
  "read_file",
  "bash",
  "grep",
  "glob",
  "list_directory",
  "edit_file",
  "write_file",
]);
const KEEP_RECENT_TOOL_RESULTS = 3;
const KEEP_RECENT_MESSAGES = 10;
export const CONTEXT_TOKEN_THRESHOLD = 100_000;

export interface CompactionResult {
  messages: ModelMessage[];
  summary: string;
  compressedCount: number;
}

/** 粗略估算 token 数（约 4 字符 ≈ 1 token） */
export function estimateTokens(messages: ModelMessage[]): number {
  const text = JSON.stringify(messages);
  return Math.ceil(text.length / 4);
}

/** 将消息序列化为纯文本，供压缩 prompt 使用 */
function serializeMessages(messages: ModelMessage[]): string {
  return messages
    .map((msg) => {
      const content =
        typeof msg.content === "string"
          ? msg.content
          : JSON.stringify(msg.content);
      return `[${msg.role}]\n${content}`;
    })
    .join("\n\n");
}

export function microcompact(messages: ModelMessage[]): {
  messages: ModelMessage[];
  cleared: number;
} {
  // 找到所有 tool result 消息的位置
  const toolResultIndices: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === "tool") toolResultIndices.push(i);
  }

  // 保留最近 N 个工具结果不动，只清理更早的
  const toClear = toolResultIndices.slice(
    0,
    Math.max(0, toolResultIndices.length - KEEP_RECENT_TOOL_RESULTS),
  );

  let cleared = 0;
  const result = messages.map((msg, idx) => {
    if (!toClear.includes(idx)) return msg;
    if (msg.role !== "tool") return msg;
    const toolName = (msg.content[0] as { toolName?: string })?.toolName;
    if (!toolName || !CLEARABLE_TOOLS.has(toolName)) return msg;

    cleared++;
    return {
      ...msg,
      content: msg.content.map((part) =>
        part.type === "tool-result"
          ? {
              ...part,
              output: { type: "text" as const, value: "[tool result cleared]" },
            }
          : part,
      ),
    };
  });

  return { messages: result, cleared };
}

const COMPRESS_PROMPT = `你是一个对话压缩系统。你的任务是把 Agent 和用户之间的
对话历史压缩成一份结构化摘要，确保后续对话能够无缝继续。

请严格按照以下模板输出，每个字段都要填写：

## 用户意图
（用户在这次对话中想要完成什么）

## 已完成的操作
（Agent 执行了哪些工具调用、产生了什么结果）

## 关键发现
（读取的文件内容要点、搜索结果、命令输出中的关键信息）

## 当前状态
（对话进行到哪一步了、还有什么没做完）

## 需要保留的细节
（文件路径、变量名、配置值、错误信息等不能丢失的具体内容）

注意事项：
- 用对话中使用的语言输出
- 文件路径、UUID、版本号等标识符必须原样保留，不要翻译或改写
- 不要写笼统的概述，只保留具体的、可操作的信息
- 总长度控制在 800 字以内`;

export async function summarize(
  model: LanguageModel,
  messages: ModelMessage[],
  existingSummary?: string,
): Promise<CompactionResult> {
  const tokenEstimate = estimateTokens(messages);
  if (tokenEstimate < CONTEXT_TOKEN_THRESHOLD) {
    return { messages, summary: existingSummary || "", compressedCount: 0 };
  }

  // 保留最近 N 条消息，对齐到 user 消息边界
  const splitIdx = Math.max(0, messages.length - KEEP_RECENT_MESSAGES);
  let alignedIdx = splitIdx;
  while (alignedIdx < messages.length && messages[alignedIdx].role !== "user") {
    alignedIdx++;
  }
  // 如果对齐后没有可压缩的消息，直接返回
  if (alignedIdx <= 0) {
    return { messages, summary: existingSummary || "", compressedCount: 0 };
  }

  const toCompress = messages.slice(0, alignedIdx);
  const toKeep = messages.slice(alignedIdx);
  const conversationText = serializeMessages(toCompress);

  // 如果有上一次的摘要，合并进去一起压缩
  const userPrompt = existingSummary
    ? `## 已有摘要\n\n${existingSummary}\n\n## 新对话\n\n${conversationText}`
    : conversationText;

  const { text: summary } = await generateText({
    model,
    system: COMPRESS_PROMPT,
    prompt: userPrompt,
  });

  // 摘要作为第一条消息，后面跟着保留的最近对话
  const summaryMessage: ModelMessage = {
    role: "user",
    content: `[以下是之前对话的压缩摘要]\n\n${summary}\n\n[摘要结束]`,
  };

  return {
    messages: [summaryMessage, ...toKeep],
    summary,
    compressedCount: toCompress.length,
  };
}
