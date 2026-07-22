import type { CommandHandler } from "./index.js";

/**
 * /memory        — 显示记忆统计
 * /memory search <query> — 搜索记忆
 */
const memoryCommand: CommandHandler = (cmd, ctx) => {
  if (cmd === "/memory" || cmd.startsWith("/memory ")) {
    if (!ctx.memoryStore) {
      console.log("[Memory] 记忆模块尚未初始化");
      ctx.ask();
      return "async";
    }

    const subCmd = cmd.slice("/memory".length).trim();

    if (subCmd.startsWith("search ")) {
      const query = subCmd.slice("search ".length).trim();
      if (!query) {
        console.log("[Memory] 请提供搜索关键词");
        ctx.ask();
        return "async";
      }
      // 异步搜索，命令自行管理 REPL 循环
      ctx.memoryStore.search(query).then((results) => {
        if (results.length === 0) {
          console.log("[Memory] 没有找到相关记忆");
        } else {
          console.log(`[Memory] 找到 ${results.length} 条记忆：`);
          for (const r of results) {
            console.log(`  - ${r}`);
          }
        }
        ctx.ask();
      });
      return "async";
    }

    // 默认：显示记忆状态
    console.log("[Memory] 记忆模块已就绪");
    ctx.ask();
    return "async";
  }

  return false;
};

export const memoryCommands: CommandHandler[] = [memoryCommand];
