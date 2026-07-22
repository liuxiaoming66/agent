import type { CommandHandler } from "./index.js";
import type { MemoryEntry } from "../memory/store.js";

/**
 * /memory              — 列出所有记忆
 * /memory search <kw>  — 搜索记忆
 * /memory read <file>  — 读取某条记忆完整内容
 * /memory delete <file>— 删除某条记忆
 */
const memoryCommand: CommandHandler = (cmd, ctx) => {
  if (cmd !== "/memory" && !cmd.startsWith("/memory ")) return false;

  if (!ctx.memoryStore) {
    console.log("[Memory] 记忆模块尚未初始化");
    ctx.ask();
    return "async";
  }

  const subCmd = cmd.slice("/memory".length).trim();

  // /memory search <query>
  if (subCmd.startsWith("search ")) {
    const query = subCmd.slice("search ".length).trim();
    if (!query) {
      console.log("[Memory] 请提供搜索关键词");
      ctx.ask();
      return "async";
    }
    const results: MemoryEntry[] = ctx.memoryStore.search(query);
    if (results.length === 0) {
      console.log(`[Memory] 没有找到与 "${query}" 相关的记忆`);
    } else {
      console.log(`\n=== 搜索结果（${results.length} 条匹配） ===`);
      for (const r of results) {
        console.log(`  [${r.type}] ${r.name} — ${r.description} (${r.filePath})`);
      }
    }
    ctx.ask();
    return "async";
  }

  // /memory read <filename>
  if (subCmd.startsWith("read ")) {
    const filename = subCmd.slice("read ".length).trim();
    if (!filename) {
      console.log("[Memory] 请提供文件名");
      ctx.ask();
      return "async";
    }
    const entry = ctx.memoryStore.read(filename);
    if (!entry) {
      console.log(`[Memory] 未找到: ${filename}`);
    } else {
      console.log(`\n=== ${entry.name} [${entry.type}] ===`);
      console.log(`描述: ${entry.description}`);
      console.log(`文件: ${entry.filePath}`);
      console.log(`---`);
      console.log(entry.content);
    }
    ctx.ask();
    return "async";
  }

  // /memory delete <filename>
  if (subCmd.startsWith("delete ")) {
    const filename = subCmd.slice("delete ".length).trim();
    if (!filename) {
      console.log("[Memory] 请提供文件名");
      ctx.ask();
      return "async";
    }
    const ok = ctx.memoryStore.delete(filename);
    console.log(ok ? `[Memory] 已删除: ${filename}` : `[Memory] 未找到: ${filename}`);
    ctx.ask();
    return "async";
  }

  // /memory — 默认列出所有记忆
  const entries: MemoryEntry[] = ctx.memoryStore.list();
  if (entries.length === 0) {
    console.log("[Memory] 当前没有存储任何记忆");
  } else {
    console.log(`\n=== 记忆列表（共 ${entries.length} 条） ===`);
    for (const e of entries) {
      console.log(`  [${e.type}] ${e.name} — ${e.description} (${e.filePath})`);
    }
    console.log(`\n提示: /memory read <文件名> 查看详情 | /memory search <关键词> 搜索`);
  }
  ctx.ask();
  return "async";
};

export const memoryCommands: CommandHandler[] = [memoryCommand];
