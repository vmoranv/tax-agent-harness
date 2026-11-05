/**
 * 平台适配器出口。
 *
 * 已完成（A 档，可完整实现并自测）：
 * - 飞书 lark         — SHA-256 验签 + JSON 消息
 * - 钉钉 dingtalk     — HMAC-SHA256 验签 + JSON 消息
 * - 企微 wecom        — SHA-1 验签 + XML 消息
 * - QQ 官方 qqofficial — Ed25519 验签 + JSON 消息
 *
 * B 档（骨架已留，见 `platform/index.ts` 的 `PlatformAdapter` 接口）：
 * telegram / discord / slack / kook / line / mattermost / misskey /
 * weixin_official_account / wecom_ai_bot / satori
 */

export type { WebhookCodec, WebhookPlatform as WebhookPlatformBase } from '../webhook.js';
export type { DingTalkConfig } from './dingtalk.js';

export { DingTalkCodec, DingTalkPlatform } from './dingtalk.js';
export type { DiscordConfig } from './discord.js';
export { DiscordCodec, DiscordPlatform } from './discord.js';
export type { LarkConfig } from './lark.js';
export { LarkCodec, LarkPlatform } from './lark.js';
export type { QQOfficialConfig } from './qq-official.js';
export { QQOfficialCodec, QQOfficialPlatform } from './qq-official.js';
export type { SlackConfig } from './slack.js';
export { SlackCodec, SlackPlatform } from './slack.js';
export type { TelegramBinding, TelegramConfig } from './telegram.js';
export { TelegramPlatform } from './telegram.js';
export type { WecomConfig } from './wecom.js';
export { WecomCodec, WecomPlatform } from './wecom.js';
