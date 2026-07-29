import type { ScheduleType } from './types.js';

export interface ParsedSchedule {
  type: ScheduleType;
  intervalMs?: number; // interval 类型：间隔毫秒数
  onceAt?: Date; // once 类型：触发时间点
  cronFields?: string[]; // cron 类型：[分, 时, 日, 月, 周] 五字段
}

const INTERVAL_RE = /^every\s+(\d+)\s*(ms|s|m|h|d)$/i;

const UNIT_MS: Record<string, number> = {
  ms: 1,
  s: 1000,
  m: 60 * 1000,
  h: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
};

/**
 * 解析调度表达式，识别其类型并提取关键参数。
 * 支持三种格式：
 *  - interval：`every 30s` / `every 5m` / `every 2h`
 *  - once：ISO 时间戳，如 `2026-07-27T10:00:00Z`
 *  - cron：五字段表达式，如 `*\/5 * * * *`
 */
export function parseSchedule(schedule: string): ParsedSchedule {
  const expr = schedule.trim();

  // interval：every <n><unit>
  const intervalMatch = expr.match(INTERVAL_RE);
  if (intervalMatch) {
    const value = parseInt(intervalMatch[1], 10);
    const unit = intervalMatch[2].toLowerCase();
    const intervalMs = value * UNIT_MS[unit];
    if (!intervalMs || intervalMs <= 0) {
      throw new Error(`无效的间隔表达式: ${schedule}`);
    }
    return { type: 'interval', intervalMs };
  }

  // cron：包含空白的五字段表达式
  const fields = expr.split(/\s+/);
  if (fields.length === 5) {
    validateCronFields(fields);
    return { type: 'cron', cronFields: fields };
  }

  // once：ISO 时间戳
  const date = new Date(expr);
  if (!isNaN(date.getTime())) {
    return { type: 'once', onceAt: date };
  }

  throw new Error(`无法解析的调度表达式: ${schedule}`);
}

/**
 * 校验 cron 五字段的基本合法性。
 * 字段顺序：分(0-59) 时(0-23) 日(1-31) 月(1-12) 周(0-6)
 */
function validateCronFields(fields: string[]): void {
  const ranges: Array<[number, number]> = [
    [0, 59],
    [0, 23],
    [1, 31],
    [1, 12],
    [0, 6],
  ];
  fields.forEach((field, i) => {
    if (!isValidCronField(field, ranges[i])) {
      throw new Error(`cron 第 ${i + 1} 个字段非法: "${field}"`);
    }
  });
}

function isValidCronField(field: string, [min, max]: [number, number]): boolean {
  // 支持：* 、 */step 、 a 、 a-b 、 a-b/step 、 逗号分隔列表
  return field.split(',').every(part => {
    if (part === '*') return true;
    const stepMatch = part.match(/^(.+)\/(\d+)$/);
    const base = stepMatch ? stepMatch[1] : part;
    if (stepMatch && parseInt(stepMatch[2], 10) <= 0) return false;

    if (base === '*') return true;
    const rangeMatch = base.match(/^(\d+)-(\d+)$/);
    if (rangeMatch) {
      const lo = parseInt(rangeMatch[1], 10);
      const hi = parseInt(rangeMatch[2], 10);
      return lo >= min && hi <= max && lo <= hi;
    }
    const num = parseInt(base, 10);
    return !isNaN(num) && num >= min && num <= max;
  });
}

/**
 * 计算从当前时刻起，下一次匹配 cron 五字段的等待毫秒数。
 * 采用逐分钟向前扫描的方式（最多扫描约 4 年），简单可靠。
 */
export function getNextCronTime(fields: string[]): number {
  const [minute, hour, dom, month, dow] = fields;

  // 从下一分钟开始（秒/毫秒归零）
  const cursor = new Date();
  cursor.setSeconds(0, 0);
  cursor.setMinutes(cursor.getMinutes() + 1);

  const MAX_ITER = 366 * 24 * 60 * 4; // 约 4 年的分钟数
  for (let i = 0; i < MAX_ITER; i++) {
    if (
      matchField(minute, cursor.getMinutes(), 0, 59) &&
      matchField(hour, cursor.getHours(), 0, 23) &&
      matchField(month, cursor.getMonth() + 1, 1, 12) &&
      matchDay(dom, dow, cursor)
    ) {
      return cursor.getTime() - Date.now();
    }
    cursor.setMinutes(cursor.getMinutes() + 1);
  }

  throw new Error('未能在可预见范围内找到匹配的 cron 时间');
}

/**
 * 匹配「日」维度：cron 规则中，日(dom)与周(dow)只要有一个匹配即触发
 * （当两者都不是 `*` 时取并集，这是标准 cron 行为）。
 */
function matchDay(dom: string, dow: string, date: Date): boolean {
  const domRestricted = dom !== '*';
  const dowRestricted = dow !== '*';
  const domOk = matchField(dom, date.getDate(), 1, 31);
  const dowOk = matchField(dow, date.getDay(), 0, 6);

  if (domRestricted && dowRestricted) return domOk || dowOk;
  return domOk && dowOk;
}

/**
 * 判断单个 cron 字段是否匹配给定值。
 */
function matchField(field: string, value: number, min: number, max: number): boolean {
  return field.split(',').some(part => {
    if (part === '*') return true;

    const stepMatch = part.match(/^(.+)\/(\d+)$/);
    const step = stepMatch ? parseInt(stepMatch[2], 10) : 1;
    const base = stepMatch ? stepMatch[1] : part;

    let lo = min;
    let hi = max;
    if (base !== '*') {
      const rangeMatch = base.match(/^(\d+)-(\d+)$/);
      if (rangeMatch) {
        lo = parseInt(rangeMatch[1], 10);
        hi = parseInt(rangeMatch[2], 10);
      } else {
        lo = hi = parseInt(base, 10);
      }
    }

    if (value < lo || value > hi) return false;
    return (value - lo) % step === 0;
  });
}
