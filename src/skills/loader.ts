import fs from "node:fs";
import path from "node:path";

export interface SkillDefinition {
  name: string;
  description: string;
  whenToUse?: string;
  content: string;
  dirPath: string;
}

const SKILLS_DIR = ".skills";
const SKILL_FILE = "SKILL.md";

export class SkillLoader {
  private readonly baseDir: string;
  private skills = new Map<string, SkillDefinition>();

  constructor(baseDir = ".") {
    this.baseDir = baseDir;
  }

  load(): SkillDefinition[] {
    this.skills.clear();
    const skillsDir = path.join(this.baseDir, SKILLS_DIR);
    if (!fs.existsSync(skillsDir)) return [];

    const entries = fs.readdirSync(skillsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const skillFile = path.join(skillsDir, entry.name, SKILL_FILE);
      if (!fs.existsSync(skillFile)) continue;

      const raw = fs.readFileSync(skillFile, "utf-8").replace(/\r\n/g, "\n");
      const parsed = this.parseFrontmatter(raw);
      if (!parsed) continue;

      this.skills.set(entry.name, {
        name: entry.name,
        description: parsed.description,
        whenToUse: parsed.whenToUse,
        content: parsed.content,
        dirPath: path.join(skillsDir, entry.name),
      });
    }
    return this.list();
  }

  list(): SkillDefinition[] {
    return Array.from(this.skills.values());
  }

  get(name: string): SkillDefinition | undefined {
    return this.skills.get(name);
  }

  buildPromptSection(activeSkills: Set<string>): string | null {
    if (this.skills.size === 0) return null;
    const lines: string[] = [];

    // 已激活的 skill：注入完整 SOP
    for (const name of activeSkills) {
      const skill = this.skills.get(name);
      if (!skill) continue;
      lines.push(`[激活的 Skill: ${skill.name}]`);
      lines.push(skill.content);
      lines.push("");
    }

    // 未激活的 skill：常驻目录（描述 + 何时使用），让模型自行判断并主动遵循
    const available = this.list().filter((s) => !activeSkills.has(s.name));
    if (available.length > 0) {
      lines.push("[可用的 Skills]");
      lines.push(
        "以下 Skill 定义了处理特定任务的标准流程。当用户的请求符合某个 Skill 的「何时使用」时，" +
          "你必须先调用 load_skill 工具（参数 name）拿到该 Skill 的完整 SOP，再严格按其流程与输出格式执行；" +
          "不要仅凭下面的描述就自行发挥。",
      );
      for (const s of available) {
        lines.push(`- ${s.name}: ${s.description}`);
        if (s.whenToUse) lines.push(`  何时使用: ${s.whenToUse}`);
      }
    }

    return lines.length > 0 ? lines.join("\n") : null;
  }

  private parseFrontmatter(
    raw: string,
  ): { description: string; whenToUse: string; content: string } | null {
    const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
    if (!match) return { description: "", whenToUse: "", content: raw };
    const meta: Record<string, string> = {};
    for (const line of match[1].split("\n")) {
      const idx = line.indexOf(":");
      if (idx > 0) {
        const key = line.slice(0, idx).trim();
        let value = line.slice(idx + 1).trim();
        if (value.startsWith('"') && value.endsWith('"'))
          value = value.slice(1, -1);
        meta[key] = value;
      }
    }
    return {
      description: meta.description || "",
      whenToUse: meta.when_to_use || "",
      content: match[2].trim(),
    };
  }
}
