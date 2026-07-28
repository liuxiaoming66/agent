import type { SuperAgentConfig } from "../config/schema.js";
import type { PluginManager } from "../plugins/manager.js";
import type { PluginDefinition } from "../plugins/types.js";

/**
 * 按 config.plugins 逐个启用插件。
 * 需在工具统计之前调用，使计数包含插件注册的工具。
 */
export async function loadConfiguredPlugins(
  config: SuperAgentConfig,
  pluginManager: PluginManager,
  catalog: Map<string, PluginDefinition>,
): Promise<void> {
  if (config.plugins.length > 0) {
    console.log(`\n=== Plugins ===`);
  }
  for (const pluginCfg of config.plugins) {
    const def = catalog.get(pluginCfg.name);
    if (!def) {
      console.log(`  ✗ ${pluginCfg.name} — 未知插件`);
      continue;
    }
    if (!pluginCfg.enabled) {
      console.log(`  - ${pluginCfg.name} — 已禁用`);
      continue;
    }
    try {
      const tools = await pluginManager.load(def);
      console.log(`  ✓ ${pluginCfg.name} — ${tools.length} 个工具`);
    } catch (err) {
      console.log(
        `  ✗ ${pluginCfg.name} 加载失败: ${err instanceof Error ? err.message : err}`,
      );
    }
  }
}
