export type {
  IncomingMessage,
  OutgoingMessage,
  ChannelDefinition,
} from "./types.js";
export { ChannelGateway } from "./gateway.js";
export { FeishuChannel, type FeishuConfig } from "./feishu.js";
export { DingTalkChannel, type DingTalkConfig } from "./dingtalk.js";
export { WeChatChannel, type WeChatConfig } from "./wechat.js";

import type { ChannelDefinition } from "./types.js";
import { FeishuChannel } from "./feishu.js";
import { DingTalkChannel } from "./dingtalk.js";
import { WeChatChannel } from "./wechat.js";

/**
 * 根据环境变量自动创建已配置的通道实例。
 * 未配置任何凭据的通道不会创建（避免无意义的端口占用）。
 */
export function createChannelsFromEnv(): ChannelDefinition[] {
  const channels: ChannelDefinition[] = [];

  // 飞书：配置了 FEISHU_APP_ID 即启用
  if (process.env.FEISHU_APP_ID) {
    channels.push(new FeishuChannel());
  }

  // 钉钉：配置了 DINGTALK_APP_KEY 即启用
  if (process.env.DINGTALK_APP_KEY) {
    channels.push(new DingTalkChannel());
  }

  // 企业微信：配置了 WECOM_CORP_ID 即启用
  if (process.env.WECOM_CORP_ID) {
    channels.push(new WeChatChannel());
  }

  return channels;
}

/**
 * 创建所有通道（含未配置的），适合开发调试时统一启动 Dashboard。
 */
export function createAllChannels(): ChannelDefinition[] {
  return [new FeishuChannel(), new DingTalkChannel(), new WeChatChannel()];
}
