import { streamText, type ModelMessage } from "ai";
import {
  detect,
  recordCall,
  recordResult,
  resetHistory,
} from "./loop-detection.js";
import { isRetryable, calculateDelay, sleep } from "./retry.js";
import { ToolRegistry } from "../tools/registry.js";
import { normalizeUsage, type UsageTracker } from "../usage/tracker.js";

const MAX_STEPS = 15;
const MAX_RETRIES = 3;

export interface BudgetState {
  used: number;
  limit: number;
  inputTokens: number;
  outputTokens: number;
}

export async function agentLoop(
  model: any,
  registry: ToolRegistry,
  messages: ModelMessage[],
  system: string,
  budget: BudgetState,
  tracker?: UsageTracker,
) {
  let step = 0;
  console.log('model',model)
  const modelId: string = model.modelId ?? "unknown";
  resetHistory();

  while (step < MAX_STEPS) {
    step++;
    console.log(`\n--- Step ${step} ---`);

    let hasToolCall = false;
    let fullText = "";
    let shouldBreak = false;
    let lastToolCall: { name: string; input: unknown } | null = null;
    let stepResponse: Awaited<ReturnType<typeof streamText>["response"]>;
    let stepUsage: Awaited<ReturnType<typeof streamText>["usage"]>;

    // 步骤级重试：包裹整个 stream 消费过程
    for (let attempt = 1; ; attempt++) {
      try {
        const deferredHint = registry.getDeferredToolSummary();
        const finalSystem = deferredHint ? `${system}\n${deferredHint}` : system;
        const result = streamText({
          model,
          system: finalSystem,
          tools: registry.toAISDKFormat(),
          messages,
          maxRetries: 0,
          onError: () => {},
        });

        for await (const part of result.fullStream) {
          switch (part.type) {
            case "text-delta":
              process.stdout.write(part.text);
              fullText += part.text;
              break;

            case "tool-call": {
              hasToolCall = true;
              lastToolCall = { name: part.toolName, input: part.input };
              console.log(
                `  [调用: ${part.toolName}(${JSON.stringify(part.input)})]`,
              );

              const detection = detect(part.toolName, part.input);
              if (detection.stuck) {
                console.log(`  ${detection.message}`);
                if (detection.level === "critical") {
                  shouldBreak = true;
                } else {
                  messages.push({
                    role: "user" as const,
                    content: `[系统提醒] ${detection.message}。请换一个思路解决问题，不要重复同样的操作。`,
                  });
                }
              }
              recordCall(part.toolName, part.input);
              break;
            }

            case "tool-result":
              console.log(`  [结果: ${JSON.stringify(part.output)}]`);
              if (lastToolCall) {
                recordResult(
                  lastToolCall.name,
                  lastToolCall.input,
                  part.output,
                );
              }
              break;
          }
        }

        stepResponse = await result.response;
        stepUsage = await result.usage;
        break;
      } catch (error) {
        if (attempt > MAX_RETRIES || !isRetryable(error as Error)) throw error;
        const delay = calculateDelay(attempt);
        console.log(
          `  [重试] 第 ${attempt}/${MAX_RETRIES} 次失败，${delay}ms 后重试...`,
        );
        await sleep(delay);
        hasToolCall = false;
        fullText = "";
        shouldBreak = false;
        lastToolCall = null;
      }
    }

    if (shouldBreak) {
      console.log("\n[循环检测触发，Agent 已停止]");
      break;
    }

    messages.push(...stepResponse!.messages);

    // Token 预算追踪：budget 由调用方持有，跨轮持续累计
    const inp = stepUsage?.inputTokens ?? 0;
    const out = stepUsage?.outputTokens ?? 0;
    budget.inputTokens += inp;
    budget.outputTokens += out;
    budget.used += inp + out;
    const pct = Math.round((budget.used / budget.limit) * 100);
    console.log(
      `  [Token] 输入: ${budget.inputTokens} | 输出: ${budget.outputTokens} | 总计: ${budget.used}/${budget.limit} (${pct}%)`,
    );

    // 用量统计：归一化后记入 tracker，每步明确标注缓存命中情况
    const norm = normalizeUsage(stepUsage);
    const stepRecord = tracker?.record(modelId, norm);
    if (stepRecord) {
      if (norm.cacheReadTokens > 0) {
        const totalInput =
          norm.inputTokens + norm.cacheReadTokens + norm.cacheWriteTokens;
        const hitRate = Math.round((norm.cacheReadTokens / totalInput) * 100);
        console.log(
          `  [Cost] $${stepRecord.cost.toFixed(5)} · ✅ 缓存命中 ${norm.cacheReadTokens} tokens（命中率 ${hitRate}%）`,
        );
      } else {
        console.log(`  [Cost] $${stepRecord.cost.toFixed(5)} · ⚪ 未命中缓存`);
      }
    }
    // if (budget.used > budget.limit) {
    //   console.log("\n[Token 预算耗尽，强制停止]");
    //   break;
    // }

    if (!hasToolCall) {
      if (fullText) console.log();
      break;
    }

    console.log("  → 继续下一步...");
  }

  if (step >= MAX_STEPS) {
    console.log("\n[达到最大步数限制，强制停止]");
  }
}
