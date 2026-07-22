import type { ToolDefinition } from "./registry.js";

/**
 * MemoryStore 接口占位 —— 等 memory 模块实现后替换为真实导入
 */
export interface MemoryStore {
  search(query: string): Promise<string[]>;
  save(content: string): Promise<void>;
}

/**
 * 创建 memory 工具实例。
 * 工厂函数接收 memoryStore 依赖，返回可直接注册的 ToolDefinition。
 */
export function createMemoryTool(memoryStore: MemoryStore): ToolDefinition {
  return {
    name: "memory",
    description:
      "搜索或保存记忆。传入 action='search' + query 检索相关记忆，或 action='save' + content 保存新记忆",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["search", "save"],
          description: "操作类型：search 检索 / save 保存",
        },
        query: {
          type: "string",
          description: "检索关键词（action=search 时必填）",
        },
        content: {
          type: "string",
          description: "要保存的内容（action=save 时必填）",
        },
      },
      required: ["action"],
      additionalProperties: false,
    },
    isConcurrencySafe: true,
    isReadOnly: false,
    execute: async ({
      action,
      query,
      content,
    }: {
      action: string;
      query?: string;
      content?: string;
    }) => {
      if (action === "search") {
        if (!query) return "缺少 query 参数";
        const results = await memoryStore.search(query);
        if (results.length === 0) return "没有找到相关记忆";
        return results;
      }

      if (action === "save") {
        if (!content) return "缺少 content 参数";
        await memoryStore.save(content);
        return "记忆已保存";
      }

      return `未知 action: ${action}`;
    },
  };
}
