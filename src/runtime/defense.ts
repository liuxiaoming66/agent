import type { LanguageModel } from "ai";
import { applyDefense } from "../context/defense.js";
import {
  microcompact,
  summarize,
  estimateTokens,
  CONTEXT_TOKEN_THRESHOLD,
} from "../context/compressor.js";
import type { ConversationState } from "../bootstrap/types.js";

/**
 * 统一上下文防御管线，从轻到重按顺序执行：
 * Layer 2: 截断超长工具结果 + 总量预算清理
 * Layer 3: TTL 软修剪 / 硬清除
 * Token 估算: 判断是否需要 LLM 压缩
 * Layer 4: Microcompact — 清理早期工具结果
 * Layer 5: Summarization — 超阈值时 LLM 摘要压缩
 */
export async function runDefensePipeline(
  state: ConversationState,
  model: LanguageModel,
): Promise<void> {
  // Layer 2 + 3: 截断 + TTL 修剪 + token 估算
  const defense = applyDefense(state.messages, state.timestamps);
  state.messages = defense.messages;

  // 诊断日志：始终输出，方便观察防御状态
  const toolMsgCount = state.messages.filter((m) => m.role === "tool").length;
  console.log(
    `[Defense] 消息=${state.messages.length} 工具结果=${toolMsgCount} ` +
      `截断=${defense.truncated} 压缩=${defense.compacted} ` +
      `软修剪=${defense.softPruned} 硬清除=${defense.hardPruned} ` +
      `~${defense.tokenEstimate} tokens`,
  );

  // Token 估算：判断是否需要更重的压缩
  let currentTokens = defense.tokenEstimate;
  console.log(`[Token] ~${currentTokens} tokens`);
  if (currentTokens <= CONTEXT_TOKEN_THRESHOLD) return; // 轻量手段已足够

  // Layer 4: Microcompact — 清理早期工具结果
  const mc = microcompact(state.messages);
  state.messages = mc.messages;
  if (mc.cleared > 0) {
    console.log(`[Layer 4: Microcompact] 清理了 ${mc.cleared} 个工具结果`);
  }

  // 重新估算，看是否还需要最重的手段
  currentTokens = estimateTokens(state.messages);
  if (currentTokens <= CONTEXT_TOKEN_THRESHOLD) return;

  // Layer 5: Summarization — LLM 摘要压缩
  console.log(
    `[Layer 5: Summarization] ~${currentTokens} tokens 仍超阈值，压缩中...`,
  );
  const compResult = await summarize(model, state.messages, state.summary);
  state.messages = compResult.messages;
  state.summary = compResult.summary;
  if (compResult.compressedCount > 0) {
    console.log(
      `[Layer 5: Summarization] 压缩了 ${compResult.compressedCount} 条消息`,
    );
  }
}
