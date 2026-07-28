import type { ToolRegistry } from "../tools/registry.js";
import type { SuperAgentConfig } from "../config/schema.js";
import { HookPipeline } from "../security/hooks.js";

/** 构建安全管线：审计日志 pre-hook + 敏感信息脱敏 post-hook，并注入 registry */
export function setupHookPipeline(
  config: SuperAgentConfig,
  registry: ToolRegistry,
): HookPipeline {
  const hookPipeline = new HookPipeline();

  // Pre-hook: 审计日志——记录每次工具调用（config.security.auditLog 开关）
  if (config.security.auditLog) {
    hookPipeline.registerPre("audit-log", (toolName, _input) => {
      console.log(`  [audit] 调用 ${toolName}`);
      return { action: "allow" };
    });
  }

  // Post-hook: 敏感信息脱敏——将输出中的 API Key / Token 替换为占位符
  hookPipeline.registerPost("redact-secrets", (_toolName, _input, output) => {
    if (typeof output === "string") {
      const redacted = output.replace(
        /\b(sk-|ghp_|gho_|xox[bpsa]-)[A-Za-z0-9_-]{8,}\b/g,
        "[REDACTED]",
      );
      if (redacted !== output) {
        return { action: "modify", modifiedOutput: redacted };
      }
    }
    return { action: "allow" };
  });

  registry.setHookPipeline(hookPipeline);
  return hookPipeline;
}
