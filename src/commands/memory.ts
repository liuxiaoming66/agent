import type { CommandHandler } from "./index.js";
import type { MemoryEntry } from "../memory/store.js";
import { lintAll, type ValidationIssue } from "../memory/validator.js";

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

  // /memory lint
  if (subCmd === "lint" || subCmd.startsWith("lint")) {
    const entries: MemoryEntry[] = ctx.memoryStore.list();
    if (entries.length === 0) {
      console.log("[Memory] 记忆库为空，无需体检");
    } else {
      const issues: ValidationIssue[] = lintAll(entries, ".");
      if (issues.length === 0) {
        console.log(`\n=== 记忆体检通过 ✓ ===`);
        console.log(`共 ${entries.length} 条记忆，无问题。`);
      } else {
        console.log(`\n=== 记忆体检报告（共 ${issues.length} 个问题） ===`);
        const groups: Record<string, ValidationIssue[]> = {
          stale_path: issues.filter((i) => i.kind === "stale_path"),
          never_used: issues.filter((i) => i.kind === "never_used"),
          duplicate_name: issues.filter((i) => i.kind === "duplicate_name"),
        };
        if (groups.stale_path.length > 0) {
          console.log(`\n[路径失效] ${groups.stale_path.length} 条:`);
          for (const i of groups.stale_path) console.log(`  - ${i.filePath}: ${i.message}`);
        }
        if (groups.never_used.length > 0) {
          console.log(`\n[过期未读] ${groups.never_used.length} 条:`);
          for (const i of groups.never_used) console.log(`  - ${i.filePath}: ${i.message}`);
        }
        if (groups.duplicate_name.length > 0) {
          console.log(`\n[重名冲突] ${groups.duplicate_name.length} 条:`);
          for (const i of groups.duplicate_name) console.log(`  - ${i.message}`);
        }
      }
    }
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
    console.log(`\n提示: /memory read <文件名> 查看详情 | /memory search <关键词> 搜索 | /memory lint 体检`);
  }
  ctx.ask();
  return "async";
};

export const memoryCommands: CommandHandler[] = [memoryCommand];
