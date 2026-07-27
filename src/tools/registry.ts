import { jsonSchema } from "ai";
import { MCPClient } from "./mcp-client.js";
import { estimateTextTokens } from "../context/compressor.js";
import { canUseTool, type Role } from "../security/roles.js";
import { classifyBashCommand } from "../commands/bash-classifier.js";
import { HookPipeline } from "../security/hooks.js";

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  isConcurrencySafe?: boolean;
  isReadOnly?: boolean;
  maxResultChars?: number;
  shouldDefer?: boolean;
  searchHint?: string;
  execute: (input: any) => Promise<unknown>;
}

const DEFAULT_MAX_RESULT_CHARS = 3000;

export class ToolRegistry {
  private tools = new Map<string, ToolDefinition>();
  private discoveredTools = new Set<string>();
  private currentRole: Role = "owner";

  // 三个状态变量构成一把读写锁
  private exclusiveLock = false; // 当前是否有独占锁持有者
  private concurrentCount = 0; // 当前共享锁持有数
  private waitQueue: Array<() => void> = []; // 阻塞等待中的 resolve 函数
  hookPipeline: HookPipeline | undefined;

  setRole(role: Role): void {
    this.currentRole = role;
  }

  getRole(): Role {
    return this.currentRole;
  }

  register(...tools: ToolDefinition[]): void {
    for (const tool of tools) {
      this.tools.set(tool.name, tool);
    }
  }

  unregister(name: string): boolean {
    this.discoveredTools.delete(name);
    return this.tools.delete(name);
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  getAll(): ToolDefinition[] {
    return Array.from(this.tools.values());
  }

  setHookPipeline(pipeline: HookPipeline): void {
    this.hookPipeline = pipeline;
  }

  // 获取共享锁：只要没人独占就能拿，多个只读工具可以同时持有
  private async acquireConcurrent(): Promise<void> {
    while (this.exclusiveLock) {
      await new Promise<void>((r) => this.waitQueue.push(r));
    }
    this.concurrentCount++;
  }

  private releaseConcurrent(): void {
    this.concurrentCount--;
    if (this.concurrentCount === 0) this.drainQueue();
  }
  // 获取独占锁：必须等所有共享锁释放、且没人持独占
  private async acquireExclusive(): Promise<void> {
    while (this.exclusiveLock || this.concurrentCount > 0) {
      await new Promise<void>((r) => this.waitQueue.push(r));
    }
    this.exclusiveLock = true;
  }

  private releaseExclusive(): void {
    this.exclusiveLock = false;
    this.drainQueue();
  }
  // 锁释放时把等待队列全唤醒，让它们重新去抢锁
  private drainQueue(): void {
    const waiting = this.waitQueue.splice(0);
    for (const resolve of waiting) resolve();
  }

  toAISDKFormat(): Record<string, any> {
    const result: Record<string, any> = {};
    for (const tool of this.getActiveTools()) {
      const name = tool.name;
      const maxChars = tool.maxResultChars;
      const executeFn = tool.execute;
      const isSafe = tool.isConcurrencySafe === true;
      const registry = this;

      result[name] = {
        description: tool.description,
        inputSchema: jsonSchema(tool.parameters as any),
        execute: async (input: any) => {
          // 在 execute 函数里，实际调用前：
          if (name === "bash" && input?.command) {
            const risk = classifyBashCommand(input.command);
            if (risk.level === "dangerous") {
              return `[拒绝执行] 检测到危险操作: ${risk.reason}\n命令: ${input.command}`;
            }
            if (risk.level === "moderate") {
              console.log(`  [安全] ⚠ ${risk.reason}: ${input.command}`);
            }
          }
          // 在真正执行前先按 isConcurrencySafe 获取锁
          if (isSafe) {
            await registry.acquireConcurrent();
            console.log(`  [并发] ${name} 获取共享锁`);
          } else {
            await registry.acquireExclusive();
            console.log(`  [串行] ${name} 获取独占锁，等待其他工具完成`);
          }
          try {
            if (registry.hookPipeline) {
              const preResult = await registry.hookPipeline.runPre(name, input);
              if (preResult.action === "block") {
                return `[Hook 拦截] ${preResult.reason || "操作被阻止"}`;
              }
              if (
                preResult.action === "modify" &&
                preResult.modifiedInput !== undefined
              ) {
                input = preResult.modifiedInput;
              }
            }

            let raw = await executeFn(input);
            if (registry.hookPipeline) {
              const postResult = await registry.hookPipeline.runPost(
                name,
                input,
                raw,
              );
              if (postResult.modifiedOutput !== undefined) {
                raw = postResult.modifiedOutput;
              }
            }
            const text =
              typeof raw === "string" ? raw : JSON.stringify(raw, null, 2);
            return truncateResult(text, maxChars);
          } finally {
            // 不管成功还是抛异常，锁都要释放
            if (isSafe) {
              registry.releaseConcurrent();
            } else {
              registry.releaseExclusive();
            }
          }
        },
      };
    }
    return result;
  }

  // 无锁版本：供子 Agent 使用，绕过父 Agent 的读写锁避免死锁；excluded 用于排除 spawn_agent 等防递归
  toAISDKFormatUnlocked(excluded?: Set<string>): Record<string, any> {
    const result: Record<string, any> = {};
    for (const tool of this.getActiveTools()) {
      if (excluded?.has(tool.name)) continue;
      const name = tool.name;
      const maxChars = tool.maxResultChars;
      const executeFn = tool.execute;
      const registry = this;

      result[name] = {
        description: tool.description,
        inputSchema: jsonSchema(tool.parameters as any),
        execute: async (input: any) => {
          if (name === "bash" && input?.command) {
            const risk = classifyBashCommand(input.command);
            if (risk.level === "dangerous") {
              return `[拒绝执行] 检测到危险操作: ${risk.reason}\n命令: ${input.command}`;
            }
            if (risk.level === "moderate") {
              console.log(`  [安全] ⚠ ${risk.reason}: ${input.command}`);
            }
          }
          if (registry.hookPipeline) {
            const preResult = await registry.hookPipeline.runPre(name, input);
            if (preResult.action === "block") {
              return `[Hook 拦截] ${preResult.reason || "操作被阻止"}`;
            }
            if (
              preResult.action === "modify" &&
              preResult.modifiedInput !== undefined
            ) {
              input = preResult.modifiedInput;
            }
          }

          let raw = await executeFn(input);
          if (registry.hookPipeline) {
            const postResult = await registry.hookPipeline.runPost(
              name,
              input,
              raw,
            );
            if (postResult.modifiedOutput !== undefined) {
              raw = postResult.modifiedOutput;
            }
          }
          const text =
            typeof raw === "string" ? raw : JSON.stringify(raw, null, 2);
          return truncateResult(text, maxChars);
        },
      };
    }
    return result;
  }

  getActiveTools(): ToolDefinition[] {
    return this.getAll().filter((tool) => {
      if (tool.shouldDefer && !this.discoveredTools.has(tool.name)) {
        return false;
      }
      if (!canUseTool(this.currentRole, tool.name)) {
        return false; // ← 角色不允许的工具直接不暴露给模型
      }
      return true;
    });
  }

  searchTools(query: string): ToolDefinition[] {
    const q = query.trim();
    const results: ToolDefinition[] = [];

    const names = q.includes(",")
      ? q
          .split(",")
          .map((n) => n.trim())
          .filter(Boolean)
      : [q];

    for (const name of names) {
      const tool = this.tools.get(name);
      if (tool && tool.name !== "tool_search") {
        results.push(tool);
        this.discoveredTools.add(tool.name);
      }
    }
    return results;
  }

  getDeferredToolSummary(): string {
    const deferred = this.getAll().filter((tool) => {
      return tool.shouldDefer && !this.discoveredTools.has(tool.name);
    });

    if (deferred.length === 0) return "";

    const lines = deferred.map((t) => {
      const hint = t.searchHint ? ` — ${t.searchHint}` : "";
      return `  - ${t.name}${hint}`;
    });

    return `\n以下工具可用，但需要先通过 tool_search 搜索获取完整定义：\n${lines.join("\n")}`;
  }

  countTokenEstimate(): { active: number; deferred: number; total: number } {
    let active = 0;
    let deferred = 0;

    for (const tool of this.tools.values()) {
      const tokens = estimateTextTokens(
        JSON.stringify({
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        }),
      );

      if (tool.shouldDefer && !this.discoveredTools.has(tool.name)) {
        deferred += tokens;
      } else {
        active += tokens;
      }
    }

    return { active, deferred, total: active + deferred };
  }

  private mcpClients: Array<MCPClient> = [];

  async registerMCPServer(
    serverName: string,
    client: MCPClient,
  ): Promise<string[]> {
    await client.connect();
    this.mcpClients.push(client);

    const tools = await client.listTools();
    const registered: string[] = [];

    for (const tool of tools) {
      const prefixedName = `mcp__${serverName}__${tool.name}`;
      if (this.tools.has(prefixedName)) continue;

      const toolClient = client;
      const originalName = tool.name;

      this.register({
        name: prefixedName,
        description: `[MCP:${serverName}] ${tool.description}`,
        parameters: tool.inputSchema as Record<string, unknown>,
        isConcurrencySafe: true,
        isReadOnly: true,
        maxResultChars: 3000,
        shouldDefer: true,
        searchHint: `${serverName} ${tool.name} ${tool.description}`,
        execute: async (input: any) => {
          return toolClient.callTool(originalName, input);
        },
      });

      registered.push(prefixedName);
    }

    return registered;
  }

  async closeAllMCP(): Promise<void> {
    for (const client of this.mcpClients) {
      await client.close();
    }
    this.mcpClients = [];
  }
}

export function truncateResult(
  text: string,
  maxChars: number = DEFAULT_MAX_RESULT_CHARS,
): string {
  if (text.length <= maxChars) return text;

  const headSize = Math.floor(maxChars * 0.6);
  const tailSize = maxChars - headSize;
  const head = text.slice(0, headSize);
  const tail = text.slice(-tailSize);
  const dropped = text.length - headSize - tailSize;

  return `${head}\n\n... [省略 ${dropped} 字符] ...\n\n${tail}`;
}
