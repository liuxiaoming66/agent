import type { CommandHandler } from "./index.js";
import type { ChannelGateway } from "../channels/gateway.js";

export function createChannelCommands(
  gateway: ChannelGateway,
): CommandHandler[] {
  return [
    // /channel 或 /channel list — 列出所有通道
    (cmd, _ctx) => {
      if (cmd !== "/channel" && cmd !== "/channel list") return false;

      const channels = gateway.list();
      if (channels.length === 0) {
        console.log("\n[channels] 没有注册的通道。\n");
        return true;
      }

      console.log("\n[channels]");
      for (const ch of channels) {
        console.log(`  • ${ch.name} — ${ch.description}`);
      }
      console.log("");
      return true;
    },
    

    // /channel start — 启动所有通道
    (cmd, _ctx) => {
      if (cmd !== "/channel start") return false;
      console.log("\n[channels] 启动所有通道...");
      gateway.startAll().then(() => {
        console.log("[channels] 启动完成\n");
      });
      return "async";
    },

    // /channel stop — 停止所有通道
    (cmd, _ctx) => {
      if (cmd !== "/channel stop") return false;
      console.log("\n[channels] 停止所有通道...");
      gateway.stopAll().then(() => {
        console.log("[channels] 已停止\n");
      });
      return "async";
    },

    // /channel status — 显示通道状态概览
    (cmd, _ctx) => {
      if (cmd !== "/channel status") return false;
      const channels = gateway.list();
      console.log("\n[channels] 状态概览:");
      if (channels.length === 0) {
        console.log("  无已注册通道");
      } else {
        for (const ch of channels) {
          console.log(`  • ${ch.name} — ${ch.description}`);
        }
      }
      console.log("");
      return true;
    },
  ];
}
