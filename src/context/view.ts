import { type ModelMessage } from "ai";
import { estimateTokens, estimateTextTokens } from "./compressor.js";

/**
 * 上下文看板（/context）：
 * 把模型的上下文窗口切成 256 份（16×16 矩阵），每份约 windowSize/256 tokens，
 * 按 system → tools → messages 的顺序填彩色方块，剩余为空闲，末尾预留输出缓冲。
 * 用于一眼看清"谁在占用上下文"——是不是历史消息把推理空间挤没了，或工具列表悄悄涨了。
 */

/** 上下文窗口总长（tokens）。默认按 1M 计，应与所用模型的实际窗口保持一致。 */
export const CONTEXT_WINDOW = 1_000_000;

/** 为模型输出预留的缓冲（tokens），不计入可用上下文。 */
export const OUTPUT_BUFFER = 8_192;

/** 矩阵尺寸：16×16 = 256 个方块。 */
const GRID = 16;
const CELLS = GRID * GRID;

const RESET = "\x1b[0m";

type SliceKind = "system" | "memory" | "tools" | "messages" | "free" | "buffer";

const STYLE: Record<
  SliceKind,
  { glyph: string; color: string; label: string }
> = {
  system: { glyph: "●", color: "\x1b[35m", label: "System Prompt" }, // 紫
  memory: { glyph: "●", color: "\x1b[32m", label: "记忆" }, // 绿
  tools: { glyph: "●", color: "\x1b[33m", label: "工具定义" }, // 黄
  messages: { glyph: "●", color: "\x1b[36m", label: "消息历史" }, // 青
  free: { glyph: "○", color: "\x1b[90m", label: "空闲" }, // 灰
  buffer: { glyph: "▢", color: "\x1b[34m", label: "输出预留" }, // 蓝
};

/** 某一时刻上下文各组成部分的 token 占用快照。 */
export interface ContextSnapshot {
  windowSize: number;
  systemTokens: number;
  memoryTokens: number;
  toolsTokens: number;
  messagesTokens: number;
  bufferTokens: number;
}

/** 从当前运行时状态采集快照。toolsTokens 传 registry.countTokenEstimate().active。 */
export function buildContextSnapshot(opts: {
  system: string;
  toolsTokens: number;
  messages: ModelMessage[];
  memorySection?: string;
  windowSize?: number;
  bufferTokens?: number;
}): ContextSnapshot {
  const memoryTokens = opts.memorySection
    ? estimateTextTokens(opts.memorySection)
    : 0;
  return {
    windowSize: opts.windowSize ?? CONTEXT_WINDOW,
    systemTokens: estimateTextTokens(opts.system),
    memoryTokens,
    toolsTokens: opts.toolsTokens,
    messagesTokens: estimateTokens(opts.messages),
    bufferTokens: opts.bufferTokens ?? OUTPUT_BUFFER,
  };
}

/** 渲染 16×16 方块矩阵 + 图例 + 占比明细，返回可直接 console.log 的字符串。 */
export function renderContextMatrix(snapshot: ContextSnapshot): string {
  const { windowSize, systemTokens, memoryTokens, toolsTokens, messagesTokens, bufferTokens } =
    snapshot;

  const perCell = windowSize / CELLS;
  const cellsFor = (tokens: number) => Math.round(tokens / perCell);

  let systemCells = cellsFor(systemTokens);
  let memoryCells = cellsFor(memoryTokens);
  let toolsCells = cellsFor(toolsTokens);
  let bufferCells = cellsFor(bufferTokens);
  let messagesCells = cellsFor(messagesTokens);

  // 超出窗口时优先压缩消息历史的显示格数，保证矩阵不溢出
  const fixed = systemCells + memoryCells + toolsCells + bufferCells;
  if (fixed + messagesCells > CELLS) {
    messagesCells = Math.max(0, CELLS - fixed);
  }
  const freeCells = CELLS - (systemCells + memoryCells + toolsCells + messagesCells + bufferCells);

  const cells: SliceKind[] = [
    ...Array<SliceKind>(systemCells).fill("system"),
    ...Array<SliceKind>(memoryCells).fill("memory"),
    ...Array<SliceKind>(toolsCells).fill("tools"),
    ...Array<SliceKind>(messagesCells).fill("messages"),
    ...Array<SliceKind>(freeCells).fill("free"),
    ...Array<SliceKind>(bufferCells).fill("buffer"),
  ];

  // 16×16 矩阵
  const rows: string[] = [];
  for (let r = 0; r < GRID; r++) {
    const row = cells
      .slice(r * GRID, (r + 1) * GRID)
      .map((kind) => `${STYLE[kind].color}${STYLE[kind].glyph}${RESET}`)
      .join("");
    rows.push(`  ${row}`);
  }

  // 占比明细
  const used = systemTokens + memoryTokens + toolsTokens + messagesTokens;
  const pct = (n: number) => `${((n / windowSize) * 100).toFixed(1)}%`;
  const fmt = (n: number) => n.toLocaleString();
  const line = (kind: SliceKind, tokens: number) =>
    `  ${STYLE[kind].color}${STYLE[kind].glyph}${RESET} ${STYLE[kind].label.padEnd(14)} ` +
    `${fmt(tokens).padStart(10)} tokens  ${pct(tokens).padStart(7)}`;

  const header =
    `上下文窗口 ${fmt(windowSize)} tokens · 已用 ${fmt(used)} (${pct(used)}) · ` +
    `每格 ≈ ${fmt(Math.round(perCell))} tokens`;

  return [
    "",
    header,
    ...rows,
    "",
    line("system", systemTokens),
    line("memory", memoryTokens),
    line("tools", toolsTokens),
    line("messages", messagesTokens),
    line("free", windowSize - used - bufferTokens),
    line("buffer", bufferTokens),
    "",
  ].join("\n");
}
