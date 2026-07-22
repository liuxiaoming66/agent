import type { CommandHandler } from "./index.js";
import { buildContextSnapshot, renderContextMatrix } from "../context/view.js";

/**
 * /context — 打印上下文占用可视化看板
 * /usage   — 打印累计 token 用量与成本
 */
const contextCommand: CommandHandler = (cmd, ctx) => {
  if (cmd === "/context") {
    const promptCtx = ctx.makePromptCtx();
    const system = ctx.builder.build(promptCtx);
    const snapshot = buildContextSnapshot({
      system,
      toolsTokens: ctx.registry.countTokenEstimate().active,
      messages: ctx.messages,
    });
    console.log(renderContextMatrix(snapshot));
    ctx.ask();
    return "async";
  }

  if (cmd === "/usage") {
    const totals = ctx.tracker.totals();
    console.log("\n=== 用量统计 ===");
    console.log(`  输入 tokens: ${totals.inputTokens}`);
    console.log(`  输出 tokens: ${totals.outputTokens}`);
    console.log(`  缓存读取: ${totals.cacheReadTokens}`);
    console.log(`  缓存写入: ${totals.cacheWriteTokens}`);
    console.log(`  总计: ${totals.totalTokens}`);
    console.log(`  实际成本: $${totals.cost.toFixed(6)}`);
    console.log(`  基线成本: $${totals.baselineCost.toFixed(6)}`);
    console.log(`  缓存节省: $${totals.savedCost.toFixed(6)}`);
    ctx.ask();
    return "async";
  }

  return false;
};

export const contextCommands: CommandHandler[] = [contextCommand];
