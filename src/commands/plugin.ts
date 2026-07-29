import type { CommandHandler } from "./index.js";
import type { PluginManager } from "../plugins/manager.js";
import type { PluginDefinition } from "../plugins/types.js";

/**
 * /plugin               — 列出插件状态（已加载 + 可用未加载）
 * /plugin list          — 同上
 * /plugin load <name>   — 手动加载一个插件
 * /plugin unload <name> — 卸载一个插件（会触发 destroy 并注销其工具）
 */
const pluginCommand: CommandHandler = (cmd, ctx) => {
  if (cmd !== "/plugin" && !cmd.startsWith("/plugin ")) return false;

  const manager = ctx.pluginManager as PluginManager | undefined;
  const available =
    (ctx.availablePlugins as PluginDefinition[] | undefined) ?? [];
  if (!manager) {
    console.log("[Plugin] 插件系统尚未初始化");
    ctx.ask();
    return "async";
  }

  const sub = cmd.slice("/plugin".length).trim();

  // /plugin load <name>
  if (sub.startsWith("load ")) {
    const name = sub.slice("load ".length).trim();
    const def = available.find((p) => p.name === name);
    if (!def) {
      console.log(`[Plugin] 未找到可用插件: ${name}`);
      ctx.ask();
      return "async";
    }
    manager
      .load(def)
      .then((tools) => {
        console.log(
          `[Plugin] 已加载 ${def.name} v${def.version}，注册 ${tools.length} 个工具`,
        );
      })
      .catch((err) => {
        console.log(
          `[Plugin] 加载失败: ${err instanceof Error ? err.message : err}`,
        );
      })
      .finally(() => ctx.ask());
    return "async";
  }

  // /plugin unload <name>
  if (sub.startsWith("unload ")) {
    const name = sub.slice("unload ".length).trim();
    manager
      .unload(name)
      .then((ok) => {
        console.log(ok ? `[Plugin] 已卸载: ${name}` : `[Plugin] 未加载: ${name}`);
      })
      .finally(() => ctx.ask());
    return "async";
  }

  // /plugin 或 /plugin list — 列出状态
  const loaded = manager.list();
  const loadedNames = new Set(loaded.map((p) => p.name));
  console.log(`\n=== 插件状态 ===`);
  if (loaded.length === 0) {
    console.log("  （当前没有已加载的插件）");
  } else {
    console.log(`已加载（${loaded.length}）:`);
    for (const p of loaded) {
      console.log(`  ● ${p.name} v${p.version} — ${p.description}`);
      console.log(`     工具: ${p.tools.join(", ") || "（无）"}`);
    }
  }
  const notLoaded = available.filter((p) => !loadedNames.has(p.name));
  if (notLoaded.length > 0) {
    console.log(`可用未加载（${notLoaded.length}）:`);
    for (const p of notLoaded) {
      console.log(`  ○ ${p.name} v${p.version} — ${p.description}`);
    }
  }
  console.log(`\n提示: /plugin load <name> 加载 | /plugin unload <name> 卸载`);
  ctx.ask();
  return "async";
};

export const pluginCommands: CommandHandler[] = [pluginCommand];
