import fs from "node:fs";
import path from "node:path";
import type { MemoryEntry } from "./store.js";

/** 检测到的问题类型 */
export type IssueKind = "stale_path" | "never_used" | "duplicate_name";

export interface ValidationIssue {
  kind: IssueKind;
  message: string;
  /** 关联的记忆文件名（方便定位） */
  filePath?: string;
}

/** 按记忆类型设置不同的 TTL（天数） */
const TTL_BY_TYPE: Record<string, number> = {
  user: 365,
  feedback: 90,
  project: 30,
  reference: 14,
};

/** 从记忆内容中提取引用的文件路径 */
function extractPaths(content: string): string[] {
  const paths: string[] = [];
  // 匹配 `` 代码块中的路径、引号中的路径、以及常见路径模式
  const patterns = [
    /`([^`]*[\/\\][^`]*)`/g,        // `path/to/file`
    /\b([a-zA-Z]:[\/\\][\w.\-\/\\]+)/g,  // C:\path\to\file
    /\b([\/\\][\w.\-\/\\]+\.\w+)/g,     // /path/to/file.ext
  ];
  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(content)) !== null) {
      paths.push(match[1]);
    }
  }
  return [...new Set(paths)];
}

/** 验证单条记忆 */
export function validateEntry(
  entry: MemoryEntry,
  baseDir = ".",
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  // 1. 路径过期检测
  const paths = extractPaths(entry.content);
  for (const p of paths) {
    const abs = path.isAbsolute(p) ? p : path.join(baseDir, p);
    if (!fs.existsSync(abs)) {
      issues.push({
        kind: "stale_path",
        message: `引用的路径不存在：${p}`,
        filePath: entry.filePath,
      });
    }
  }

  // 2. 按类型 TTL 判断长期未读
  if (entry.lastReadAt) {
    const staleDays = TTL_BY_TYPE[entry.type] ?? 30;
    const days = (Date.now() - entry.lastReadAt) / (1000 * 60 * 60 * 24);
    if (days > staleDays) {
      issues.push({
        kind: "never_used",
        message: `已 ${Math.floor(days)} 天没被读过，超过 ${entry.type} 类型的 ${staleDays} 天保质期`,
        filePath: entry.filePath,
      });
    }
  } else if (entry.lastWriteAt) {
    // 从未读过，但写过 — 用写入时间判断
    const staleDays = TTL_BY_TYPE[entry.type] ?? 30;
    const days = (Date.now() - entry.lastWriteAt) / (1000 * 60 * 60 * 24);
    if (days > staleDays) {
      issues.push({
        kind: "never_used",
        message: `写入后从未被读过，已过 ${Math.floor(days)} 天，超过 ${entry.type} 类型的 ${staleDays} 天保质期`,
        filePath: entry.filePath,
      });
    }
  }

  return issues;
}

/** 全库体检：逐条验证 + 重名检测 */
export function lintAll(
  entries: MemoryEntry[],
  baseDir = ".",
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  // 逐条验证
  for (const entry of entries) {
    issues.push(...validateEntry(entry, baseDir));
  }

  // 重名检测
  const nameMap = new Map<string, MemoryEntry[]>();
  for (const entry of entries) {
    const key = entry.name.toLowerCase();
    if (!nameMap.has(key)) nameMap.set(key, []);
    nameMap.get(key)!.push(entry);
  }
  for (const [name, dupes] of nameMap) {
    if (dupes.length > 1) {
      issues.push({
        kind: "duplicate_name",
        message: `记忆 "${name}" 有 ${dupes.length} 条同名记录：${dupes.map((d) => d.filePath).join(", ")}`,
        filePath: dupes[0].filePath,
      });
    }
  }

  return issues;
}
