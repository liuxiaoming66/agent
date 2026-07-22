import fs from "node:fs";
import path from "node:path";

export interface MemoryEntry {
  name: string;
  description: string;
  type: "user" | "feedback" | "project" | "reference";
  content: string;
  filePath: string;
}

const MEMORY_DIR = ".memory";
const INDEX_FILE = "MEMORY.md";
const MAX_INDEX_LINES = 200;
const MAX_FILE_CHARS = 4000;

export class MemoryStore {
  private readonly baseDir: string;

  constructor(baseDir: string = ".") {
    this.baseDir = baseDir;
  }

  private get memoryDir(): string {
    return path.join(this.baseDir, MEMORY_DIR);
  }

  private get indexPath(): string {
    return path.join(this.memoryDir, INDEX_FILE);
  }

  init(): void {
    if (!fs.existsSync(this.memoryDir)) {
      fs.mkdirSync(this.memoryDir, { recursive: true });
    }
    if (!fs.existsSync(this.indexPath)) {
      fs.writeFileSync(this.indexPath, "# Memory Index\n", "utf-8");
    }
  }

  /** 读取记忆索引内容（供内部使用） */
  private loadIndex(): string {
    if (!fs.existsSync(this.indexPath)) return "";
    const raw = fs.readFileSync(this.indexPath, "utf-8").trim();
    const lines = raw.split("\n").filter((l) => !l.startsWith("#") && l.trim() !== "");
    return lines.join("\n");
  }

  /** 构建记忆系统提示词段落（注入 system prompt） */
  buildPromptSection(): string {
    this.init();
    const index = this.loadIndex();
    const entries = this.list();

    if (entries.length === 0) {
      return "[记忆系统] 当前没有存储任何记忆。你可以使用 memory 工具来保存重要信息。";
    }

    const lines = [
      `[记忆系统] 共 ${entries.length} 条记忆`,
      "",
      "记忆索引：",
      index,
      "",
      "使用 memory 工具的 read 操作来读取具体记忆内容。",
      "记忆是线索，不是事实——使用前先验证其准确性。",
    ];
    return lines.join("\n");
  }

  save(entry: Omit<MemoryEntry, "filePath">): string {
    this.init();
    const slug = entry.name
      .toLowerCase()
      .replace(/[^a-z0-9一-鿿]+/g, "-")
      .replace(/^-|-$/g, "");
    const filename = `${entry.type}_${slug}.md`;
    const filePath = path.join(this.memoryDir, filename);

    const fileContent = [
      "---",
      `name: ${entry.name}`,
      `description: ${entry.description}`,
      `type: ${entry.type}`,
      "---",
      "",
      entry.content,
    ].join("\n");

    fs.writeFileSync(filePath, fileContent, "utf-8");
    this.updateIndex(entry.name, filename, entry.description);
    return filename;
  }

  list(): MemoryEntry[] {
    this.init();
    const files = fs
      .readdirSync(this.memoryDir)
      .filter((f) => f.endsWith(".md") && f !== INDEX_FILE);

    const entries: MemoryEntry[] = [];
    for (const file of files) {
      const filePath = path.join(this.memoryDir, file);
      const raw = fs.readFileSync(filePath, "utf-8");
      const parsed = this.parseFrontmatter(raw);
      if (!parsed) continue;

      entries.push({
        name: parsed.meta.name ?? file.replace(/\.md$/, ""),
        description: parsed.meta.description ?? "",
        type: (parsed.meta.type as MemoryEntry["type"]) ?? "reference",
        content: parsed.body.slice(0, MAX_FILE_CHARS),
        filePath: file,
      });
    }
    return entries;
  }

  search(query: string): MemoryEntry[] {
    const all = this.list();
    const keywords = query.toLowerCase().split(/\s+/);
    return all.filter((entry) => {
      const text =
        `${entry.name} ${entry.description} ${entry.content}`.toLowerCase();
      return keywords.some((kw) => text.includes(kw));
    });
  }

  /** 读取单条记忆的完整内容 */
  read(filename: string): MemoryEntry | null {
    const filePath = path.join(this.memoryDir, filename);
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = this.parseFrontmatter(raw);
    if (!parsed) return null;
    return {
      name: parsed.meta.name ?? filename.replace(/\.md$/, ""),
      description: parsed.meta.description ?? "",
      type: (parsed.meta.type as MemoryEntry["type"]) ?? "reference",
      content: parsed.body,
      filePath: filename,
    };
  }

  /** 删除一条记忆并同步更新索引 */
  delete(filename: string): boolean {
    const filePath = path.join(this.memoryDir, filename);
    if (!fs.existsSync(filePath)) return false;
    fs.unlinkSync(filePath);
    this.rebuildIndex();
    return true;
  }

  // ─── 私有方法 ───────────────────────────────────────────

  /** 解析 YAML frontmatter（--- 包裹的头部）+ 正文 */
  private parseFrontmatter(
    raw: string,
  ): { meta: Record<string, string>; body: string } | null {
    const match = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
    if (!match) return null;

    const meta: Record<string, string> = {};
    for (const line of match[1].split("\n")) {
      const idx = line.indexOf(":");
      if (idx === -1) continue;
      const key = line.slice(0, idx).trim();
      const value = line.slice(idx + 1).trim();
      meta[key] = value;
    }
    return { meta, body: match[2].trim() };
  }

  /** 在 MEMORY.md 索引中追加/更新一条记录 */
  private updateIndex(
    name: string,
    filename: string,
    description: string,
  ): void {
    let index = "";
    if (fs.existsSync(this.indexPath)) {
      index = fs.readFileSync(this.indexPath, "utf-8");
    }

    // 如果已有同名条目则先移除旧行
    const lines = index.split("\n").filter((l) => !l.includes(`(${filename})`));

    // 追加新条目
    lines.push(`- **${name}** — ${description} (${filename})`);

    // 超出最大行数时裁剪尾部（保留标题行）
    const header = lines[0]?.startsWith("#") ? lines[0] : "# Memory Index";
    let body = lines.filter((l) => l !== header && l.trim() !== "");
    if (body.length > MAX_INDEX_LINES) {
      body = body.slice(body.length - MAX_INDEX_LINES);
    }

    fs.writeFileSync(this.indexPath, [header, "", ...body, ""].join("\n"), "utf-8");
  }

  /** 全量重建索引（删除文件后调用） */
  private rebuildIndex(): void {
    const entries = this.list();
    const lines = ["# Memory Index", ""];
    for (const e of entries) {
      lines.push(`- **${e.name}** — ${e.description} (${e.filePath})`);
    }
    fs.writeFileSync(this.indexPath, lines.join("\n") + "\n", "utf-8");
  }
}
