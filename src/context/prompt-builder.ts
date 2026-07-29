import type { SqliteVectorStore } from "../rag/sqlite-store.js";

export interface PromptContext {
  toolCount: number;
  deferredToolSummary: string;
  sessionMessageCount: number;
  sessionId: string;
}

type PipeFn = (ctx: PromptContext) => string | null;

export class PromptBuilder {
  private pipes: Array<{ name: string; fn: PipeFn }> = [];

  pipe(name: string, fn: PipeFn): this {
    this.pipes.push({ name, fn });
    return this;
  }

  build(ctx: PromptContext): string {
    const sections: string[] = [];
    for (const { fn } of this.pipes) {
      const result = fn(ctx);
      if (result !== null) {
        sections.push(result);
      }
    }
    return sections.join("\n\n");
  }

  debug(ctx: PromptContext): void {
    console.log("\n=== Prompt Pipe Debug ===");
    for (const { name, fn } of this.pipes) {
      const result = fn(ctx);
      const status = result !== null ? `[ON] ${result.length} chars` : "[OFF]";
      console.log(`  ${name}: ${status}`);
    }
    console.log("========================\n");
  }
}

export function coreRules(): PipeFn {
  return () => `你是 Super Agent，一个有工具调用能力的 AI 助手。
需要查询信息时，主动使用工具，不要编造数据。
回答要简洁直接。`;
}

export function toolGuide(): PipeFn {
  return (ctx) => {
    if (ctx.toolCount === 0) return null;
    return `你有 ${ctx.toolCount} 个工具可用...`;
  };
}

export function deferredTools(): PipeFn {
  return (ctx) => {
    if (!ctx.deferredToolSummary) return null;
    return ctx.deferredToolSummary;
  };
}

export function sessionContext(): PipeFn {
  return (ctx) => {
    if (ctx.sessionMessageCount === 0) return null;
    return `[会话信息] 已有 ${ctx.sessionMessageCount} 条历史消息`;
  };
}

/**
 * 记忆上下文 pipe：将已保存的记忆索引注入 system prompt，
 * 让模型每轮都能“记得”用户偏好、项目信息等。
 */
export function memoryContext(getMemorySection: () => string): PipeFn {
  return () => {
    const section = getMemorySection();
    if (!section) return null;
    return section;
  };
}

export function ragContext(getStore: () => SqliteVectorStore): (ctx: PromptContext) => string | null {
  return () => {
    const store = getStore();
    const size = store.size();
    if (size === 0) return null;
    const sources = store.sources();
    return `[知识库] 已导入 ${size} 个文档片段（来源: ${sources.join(', ')}）。使用 rag_search 工具搜索知识库。`;
  };
}

/**
 * Skill 上下文 pipe：把已激活 skill 的 SOP 内容与可用 skill 列表注入 system prompt。
 * 与 memory / RAG 相同套路——每轮对话前动态构建，激活状态变化即时生效。
 */
export function skillContext(getSection: () => string | null): PipeFn {
  return () => getSection();
}