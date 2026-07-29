import type { ToolDefinition } from "./registry.js";
import type { SkillLoader } from "../skills/loader.js";

/**
 * 创建 load_skill 工具：按名称返回某个 Skill 的完整 SOP，并标记为激活。
 *
 * 配合 system prompt 中常驻的 Skill 目录（描述 + 何时使用）使用——
 * 模型判断当前任务匹配某个 Skill 后，先调用本工具拿到完整流程，
 * 再严格按其步骤与输出格式执行。这样元数据常驻省 token，正文按需加载。
 */
export function createSkillTool(
  skillLoader: SkillLoader,
  activeSkills: Set<string>,
): ToolDefinition {
  return {
    name: "load_skill",
    description:
      "加载并激活一个 Skill，返回其完整 SOP（标准操作流程）。当你判断当前任务匹配某个 Skill 的适用场景时，" +
      "必须先调用本工具获取该 Skill 的完整流程，再严格按其步骤与输出格式执行，不要凭描述自行发挥。",
    parameters: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Skill 名称，例如 code-review",
        },
      },
      required: ["name"],
      additionalProperties: false,
    },
    isConcurrencySafe: true,
    isReadOnly: true,
    execute: async (args: any) => {
      const name = String(args?.name ?? "").trim();
      if (!name) return "加载失败：需要 name 参数";

      const skill = skillLoader.get(name);
      if (!skill) {
        const available = skillLoader.list().map((s) => s.name);
        return `未找到 Skill: ${name}。可用: ${available.join(", ") || "（无）"}`;
      }

      activeSkills.add(name);
      return `[Skill: ${skill.name}] 已激活。请严格遵循以下 SOP 的流程与输出格式：\n\n${skill.content}`;
    },
  };
}
