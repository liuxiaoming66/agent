import type { CommandHandler } from "./index.js";
import type { SkillLoader, SkillDefinition } from "../skills/loader.js";

/**
 * /skill               — 列出所有 skill 及激活状态
 * /skill list          — 同上
 * /skill load <name>   — 激活一个 skill（内容注入 system prompt）
 * /skill unload <name> — 卸载一个 skill
 *
 * 快捷方式 /<skill-name>（如 /code-review）：
 *   激活 skill 的同时，把 skill 内容作为 user message 注入并立即执行，
 *   省去先 load 再手动描述需求的步骤。
 */
const skillCommand: CommandHandler = (cmd, ctx) => {
  const loader = ctx.skillLoader as SkillLoader | undefined;
  const active = ctx.activeSkills as Set<string> | undefined;
  if (!loader || !active) return false;

  // ---- /skill 管理命令 ----
  if (cmd === "/skill" || cmd.startsWith("/skill ")) {
    const sub = cmd.slice("/skill".length).trim();

    // /skill load <name>
    if (sub.startsWith("load ")) {
      const name = sub.slice("load ".length).trim();
      const skill = loader.get(name);
      if (!skill) {
        console.log(`[Skill] 未找到: ${name}`);
      } else {
        active.add(name);
        console.log(`[Skill] 已激活: ${name} — ${skill.description}`);
      }
      ctx.ask();
      return "async";
    }

    // /skill unload <name>
    if (sub.startsWith("unload ")) {
      const name = sub.slice("unload ".length).trim();
      console.log(
        active.delete(name)
          ? `[Skill] 已卸载: ${name}`
          : `[Skill] 未激活: ${name}`,
      );
      ctx.ask();
      return "async";
    }

    // /skill 或 /skill list — 列出所有 skill
    const skills: SkillDefinition[] = loader.list();
    if (skills.length === 0) {
      console.log("[Skill] 未发现任何 skill（.skills/<name>/SKILL.md）");
    } else {
      console.log(`\n=== Skill 列表（共 ${skills.length} 个） ===`);
      for (const s of skills) {
        const mark = active.has(s.name) ? "●" : "○";
        console.log(`  ${mark} /${s.name} — ${s.description}`);
      }
      console.log(
        `\n提示: /skill load <name> 激活 | /skill unload <name> 卸载 | /<name> 激活并立即执行`,
      );
    }
    ctx.ask();
    return "async";
  }

  // ---- 快捷方式 /<skill-name> [额外需求] ----
  if (cmd.startsWith("/")) {
    // 第一个 token 是 skill 名，其余是用户本轮的具体需求
    const rest = cmd.slice(1).trim();
    const spaceIdx = rest.search(/\s/);
    const name = spaceIdx === -1 ? rest : rest.slice(0, spaceIdx);
    const extra = spaceIdx === -1 ? "" : rest.slice(spaceIdx + 1).trim();
    const skill = loader.get(name);
    if (!skill) return false; // 不是已知 skill，交还给普通对话流程

    active.add(name);
    console.log(`\n[Skill] 已激活 ${name} 并注入 SOP，开始执行...`);
    const sop = extra
      ? `请严格按以下 SOP 流程执行任务。\n\n【用户本轮需求】${extra}\n\n【SOP】\n${skill.content}`
      : `请严格按以下 SOP 流程执行任务：\n\n${skill.content}`;

    if (!ctx.runAgentTurn) {
      console.log("[Skill] 缺少执行器，已仅激活（未注入执行）");
      ctx.ask();
      return "async";
    }
    void ctx.runAgentTurn(sop).then(() => ctx.ask());
    return "async";
  }

  return false;
};

export const skillCommands: CommandHandler[] = [skillCommand];
