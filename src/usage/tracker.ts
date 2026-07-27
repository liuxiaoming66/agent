export interface ModelPricing {
  input: number; // $/1M tokens (cache miss)
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

/** 单步模型调用的归一化 token 用量 */
export interface StepUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/** 用量来源：主 Agent 循环 or 子 Agent */
export type UsageSource = "main" | "subagent";

/** 单条用量记录：时间戳 + 模型 + 成本 + token 明细 */
export interface StepRecord extends StepUsage {
  ts: number;
  model: string;
  cost: number;
  source: UsageSource;
}

export const PRICE_TABLE: Record<string, ModelPricing> = {
  "claude-sonnet-4-7": {
    input: 3.0,
    output: 15.0,
    cacheWrite: 3.75,
    cacheRead: 0.3,
  },
  "claude-haiku-4-5": {
    input: 1.0,
    output: 5.0,
    cacheWrite: 1.25,
    cacheRead: 0.1,
  },
  "gpt-5": { input: 5.0, output: 15.0, cacheWrite: 5.0, cacheRead: 1.25 },
  "deepseek-v3-2": {
    input: 0.27,
    output: 1.1,
    cacheWrite: 0.27,
    cacheRead: 0.027,
  },
  "qwen3.7-plus": { input: 0.4, output: 1.2, cacheWrite: 0.4, cacheRead: 0.04 },
  "mock-model": { input: 1.0, output: 5.0, cacheWrite: 1.25, cacheRead: 0.1 },
};

export function normalizeUsage(usage: any): StepUsage {
  if (!usage)
    return {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };

  // AI SDK v7：缓存明细在 inputTokenDetails 下；旧版/原生字段作为兼容兑底
  const cacheRead =
    usage.inputTokenDetails?.cacheReadTokens ?? // AI SDK v7 标准字段
    usage.cachedInputTokens ?? // 旧版 AI SDK
    usage.providerMetadata?.openai?.cachedTokens ?? // OpenAI 原生
    0;

  const cacheWrite =
    usage.inputTokenDetails?.cacheWriteTokens ?? // AI SDK v7 标准字段
    usage.cacheCreationInputTokens ?? // 旧版 / Anthropic
    usage.providerMetadata?.anthropic?.cacheCreationInputTokens ??
    0;

  // inputTokens 是总量（含缓存）；优先用 SDK 算好的 noCacheTokens，
  // 否则手动减去 cacheRead + cacheWrite 得到纯输入
  const inputTokens =
    usage.inputTokenDetails?.noCacheTokens ??
    Math.max(0, (usage.inputTokens ?? 0) - cacheRead - cacheWrite);

  return {
    inputTokens,
    outputTokens: usage.outputTokens ?? 0,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
  };
}
export class UsageTracker {
  private steps: StepRecord[] = [];

  record(model: string, usage: StepUsage, source: UsageSource = "main"): StepRecord {
    const cost = computeCost(model, usage);
    const record = { ts: Date.now(), model, cost, source, ...usage };
    this.steps.push(record);
    return record;
  }

  totals(source?: UsageSource) {
    let inputTokens = 0,
      outputTokens = 0,
      cacheReadTokens = 0,
      cacheWriteTokens = 0,
      cost = 0,
      baselineCost = 0;

    const steps = source ? this.steps.filter((s) => s.source === source) : this.steps;
    for (const s of steps) {
      inputTokens += s.inputTokens;
      outputTokens += s.outputTokens;
      cacheReadTokens += s.cacheReadTokens;
      cacheWriteTokens += s.cacheWriteTokens;
      cost += s.cost;

      // baseline：假设没有 cache，缓存 token 全部按 input 全价计
      const pricing = PRICE_TABLE[s.model];
      if (pricing) {
        baselineCost +=
          ((s.inputTokens + s.cacheReadTokens + s.cacheWriteTokens) / 1_000_000) *
            pricing.input +
          (s.outputTokens / 1_000_000) * pricing.output;
      } else {
        baselineCost += s.cost; // 未知模型无定价，按实际成本兜底
      }
    }

    return {
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      totalTokens: inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens,
      cost,
      baselineCost,
      savedCost: baselineCost - cost,
    };
  }
}

/** 根据 PRICE_TABLE 计算单步成本（美元） */
function computeCost(model: string, usage: StepUsage): number {
  const pricing = PRICE_TABLE[model];
  if (!pricing) return 0;
  return (
    (usage.inputTokens / 1_000_000) * pricing.input +
    (usage.outputTokens / 1_000_000) * pricing.output +
    (usage.cacheWriteTokens / 1_000_000) * pricing.cacheWrite +
    (usage.cacheReadTokens / 1_000_000) * pricing.cacheRead
  );
}