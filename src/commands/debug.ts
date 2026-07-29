import type { CommandHandler } from "./index.js";

/**
 * 调试/诊断命令：
 * sim      — 模拟一轮对话（不实际调用模型）
 * defend   — 手动触发防御管线
 * status   — 打印当前会话状态
 * cache on / cache off — 开关缓存统计显示
 */
const debugCommand: CommandHandler = (cmd, ctx) => {
  if (cmd === "status") {
    console.log("\n=== 会话状态 ===");
    console.log(`  消息数: ${ctx.messages.length}`);
    console.log(`  时间戳条目: ${ctx.timestamps.size}`);
    const estimate = ctx.registry.countTokenEstimate();
    console.log(
      `  工具 Token: ~${estimate.active} (活跃) + ~${estimate.deferred} (延迟)`,
    );
    ctx.ask();
    return "async";
  }

  if (cmd === "cache on" || cmd === "cache off") {
    const enabled = cmd === "cache on";
    // 预留：后续可接入 tracker 的缓存显示开关
    console.log(`[Cache] 缓存统计显示已${enabled ? "开启" : "关闭"}`);
    ctx.ask();
    return "async";
  }

  return false;
};

export const debugCommands: CommandHandler[] = [debugCommand];
