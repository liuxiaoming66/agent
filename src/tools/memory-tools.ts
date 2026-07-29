import type { ToolDefinition } from "./registry.js";
import type { MemoryStore, MemoryEntry } from "../memory/store.js";
import { lintAll, type ValidationIssue } from "../memory/validator.js";

/**
 * 创建 memory 工具实例。
 * 工厂函数接收 memoryStore 依赖，返回可直接注册的 ToolDefinition。
 */
export function createMemoryTool(memoryStore: MemoryStore): ToolDefinition {
  return {
    name: "memory",
    description:
      "管理跨会话记忆。action: save（保存）| list（列表）| search（搜索）| read（读取）| delete（删除）| lint（体检）",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["save", "list", "search", "read", "delete", "lint"],
        },
        name: { type: "string", description: "记忆名称（save 时必填）" },
        description: {
          type: "string",
          description: "一句话描述（save 时必填）",
        },
        type: {
          type: "string",
          enum: ["user", "feedback", "project", "reference"],
        },
        content: { type: "string", description: "记忆内容（save 时必填）" },
        query: { type: "string", description: "搜索关键词（search 时必填）" },
        filename: {
          type: "string",
          description: "文件名（read/delete 时必填）",
        },
      },
      required: ["action"],
      additionalProperties: false,
    },
    isConcurrencySafe: false,
    isReadOnly: false,
    execute: async (args: any) => {
      switch (args.action) {
        case "save": {
          if (!args.name || !args.type || !args.content) {
            return "保存失败：需要 name、type、content 参数";
          }
          const filename = memoryStore.save({
            name: args.name,
            description: args.description || args.name,
            type: args.type,
            content: args.content,
          });
          return `已保存到记忆: ${filename}`;
        }
        case "list": {
          const entries: MemoryEntry[] = memoryStore.list();
          if (entries.length === 0) return "当前没有存储任何记忆。";
          return (
            `记忆列表（共 ${entries.length} 条记忆）：\n` +
            entries
              .map((e: MemoryEntry) => `  [${e.type}] ${e.name} — ${e.description} (${e.filePath})`)
              .join("\n")
          );
        }
        case "search": {
          const results: MemoryEntry[] = memoryStore.search(args.query || "");
          if (results.length === 0)
            return `没有找到与 "${args.query}" 相关的记忆。`;
          return (
            `搜索结果（${results.length} 条匹配）：\n` +
            results
              .map((e: MemoryEntry) => `  [${e.type}] ${e.name} — ${e.description} (${e.filePath})`)
              .join("\n")
          );
        }
        case "read": {
          if (!args.filename) return "读取失败：需要 filename 参数";
          const entry = memoryStore.read(args.filename);
          if (!entry) return `未找到文件: ${args.filename}`;
          return `## ${entry.name}\n\n${entry.description}\n\n---\n\n${entry.content}`;
        }
        case "delete": {
          if (!args.filename) return "删除失败：需要 filename 参数";
          const ok = memoryStore.delete(args.filename);
          return ok ? `已删除: ${args.filename}` : `未找到文件: ${args.filename}`;
        }
        case "lint": {
          const entries: MemoryEntry[] = memoryStore.list();
          if (entries.length === 0) return "记忆库为空，无需体检。";
          const issues: ValidationIssue[] = lintAll(entries, ".");
          if (issues.length === 0) {
            return `记忆体检通过 ✓ 共 ${entries.length} 条记忆，无问题。`;
          }
          const grouped = {
            stale_path: issues.filter((i) => i.kind === "stale_path"),
            never_used: issues.filter((i) => i.kind === "never_used"),
            duplicate_name: issues.filter((i) => i.kind === "duplicate_name"),
          };
          const lines = [`记忆体检报告（共 ${issues.length} 个问题）:`];
          if (grouped.stale_path.length > 0) {
            lines.push(`\n[路径失效] ${grouped.stale_path.length} 条:`);
            for (const i of grouped.stale_path) lines.push(`  - ${i.filePath}: ${i.message}`);
          }
          if (grouped.never_used.length > 0) {
            lines.push(`\n[过期未读] ${grouped.never_used.length} 条:`);
            for (const i of grouped.never_used) lines.push(`  - ${i.filePath}: ${i.message}`);
          }
          if (grouped.duplicate_name.length > 0) {
            lines.push(`\n[重名冲突] ${grouped.duplicate_name.length} 条:`);
            for (const i of grouped.duplicate_name) lines.push(`  - ${i.message}`);
          }
          return lines.join("\n");
        }
        default:
          return `未知 action: ${args.action}`;
      }
    },
  };
}
