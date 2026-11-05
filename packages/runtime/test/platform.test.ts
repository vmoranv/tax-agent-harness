import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { DingTalkCodec } from '../src/platform/adapters/dingtalk.js';
import { LarkCodec, LarkPlatform } from '../src/platform/adapters/lark.js';
import { QQOfficialCodec } from '../src/platform/adapters/qq-official.js';
import { WecomCodec } from '../src/platform/adapters/wecom.js';
import type { WebhookRequest } from '../src/platform/webhook.js';
import { hmacSha256Base64, sha256Hex, timingSafeEqual } from '../src/platform/webhook.js';

function req(body: unknown, headers: Record<string, string> = {}, raw?: string): WebhookRequest {
  return {
    headers,
    body,
    rawBody: raw ?? JSON.stringify(body),
  };
}

/* ------------------------------ 通用工具 ------------------------------ */

describe('Webhook 公共工具', () => {
  it('HMAC-SHA256 结果稳定', async () => {
    const a = await hmacSha256Base64('key', 'data');
    const b = await hmacSha256Base64('key', 'data');
    expect(a).toBe(b);
    expect(a.length).toBeGreaterThan(0);
  });

  it('SHA-256 hex 与 Node crypto 一致', async () => {
    const ours = await sha256Hex('hello');
    const expected = createHash('sha256').update('hello').digest('hex');
    expect(ours).toBe(expected);
  });

  it('timingSafeEqual 长度不同直接 false', () => {
    expect(timingSafeEqual('abc', 'abcd')).toBe(false);
  });

  it('timingSafeEqual 内容相同/不同', () => {
    expect(timingSafeEqual('abc', 'abc')).toBe(true);
    expect(timingSafeEqual('abc', 'abd')).toBe(false);
  });
});

/* -------------------------------- 飞书 -------------------------------- */

describe('飞书适配器', () => {
  const config = { appId: 'a', appSecret: 's', encryptKey: 'ek', verificationToken: 'vt' };

  it('URL 验证返回 challenge', async () => {
    const p = new LarkPlatform(config);
    const r = await p.handleWebhookSafe(req({ challenge: 'ch_123', type: 'url_verification' }));
    expect(r.status).toBe(200);
    expect((r.body as { challenge: string }).challenge).toBe('ch_123');
  });

  it('签名错误时拒绝', async () => {
    const p = new LarkPlatform(config);
    const r = await p.handleWebhookSafe(
      req(
        {},
        {
          'x-lark-signature': 'wrong',
          'x-lark-request-timestamp': '1',
          'x-lark-request-nonce': '2',
        },
      ),
    );
    expect(r.status).toBe(401);
  });

  it('正确签名通过', async () => {
    const p = new LarkPlatform(config);
    const body = { header: { event_type: 'im.message.receive_v1' }, event: {} };
    const raw = JSON.stringify(body);
    const ts = '1700000000';
    const nonce = 'n1';
    const sig = await sha256Hex(`${ts}${nonce}${config.encryptKey}${raw}`);

    const r = await p.handleWebhookSafe(
      req(
        body,
        { 'x-lark-signature': sig, 'x-lark-request-timestamp': ts, 'x-lark-request-nonce': nonce },
        raw,
      ),
    );
    expect(r.status).toBe(200);
  });

  it('解码文本消息', () => {
    const codec = new LarkCodec(config);
    const decoded = codec.decode(
      req({
        header: { event_type: 'im.message.receive_v1' },
        event: {
          message: {
            message_id: 'om_1',
            chat_id: 'oc_1',
            message_type: 'text',
            content: JSON.stringify({ text: '甲企业9月金额' }),
          },
          sender: { sender_id: { open_id: 'ou_1' } },
        },
      }),
    );

    expect(decoded?.platformUserId).toBe('ou_1');
    expect(decoded?.text).toBe('甲企业9月金额');
    expect(decoded?.messageId).toBe('om_1');
  });

  it('非文本消息返回 null', () => {
    const codec = new LarkCodec(config);
    const decoded = codec.decode(
      req({
        header: { event_type: 'im.message.receive_v1' },
        event: { message: { message_type: 'image' }, sender: { sender_id: { open_id: 'ou_1' } } },
      }),
    );
    expect(decoded).toBeNull();
  });

  it('非消息事件返回 null（如加入群聊）', () => {
    const codec = new LarkCodec(config);
    expect(codec.decode(req({ header: { event_type: 'im.chat.member.bot.added_v1' } }))).toBeNull();
  });
});

/* -------------------------------- 钉钉 -------------------------------- */

describe('钉钉适配器', () => {
  const config = { clientId: 'c', clientSecret: 'cs', appSecret: 'as' };

  it('缺少签名头时拒绝', async () => {
    const codec = new DingTalkCodec(config);
    expect(await codec.verifyAsync(req({}))).toBe(false);
  });

  it('正确 HMAC 签名通过', async () => {
    const codec = new DingTalkCodec(config);
    const ts = '1700000000';
    const sig = await hmacSha256Base64(config.appSecret, `${ts}\n${config.appSecret}`);
    expect(await codec.verifyAsync(req({}, { timestamp: ts, sign: sig }))).toBe(true);
  });

  it('错误签名拒绝', async () => {
    const codec = new DingTalkCodec(config);
    expect(await codec.verifyAsync(req({}, { timestamp: '1700000000', sign: 'wrong' }))).toBe(
      false,
    );
  });

  it('解码文本消息', () => {
    const codec = new DingTalkCodec(config);
    const d = codec.decode(
      req({
        msgtype: 'text',
        msgId: 'msg_1',
        text: { content: ' 乙企业缺哪些用途 ' },
        senderStaffId: 'staff_1',
        conversationId: 'cid_1',
      }),
    );
    expect(d?.text).toBe('乙企业缺哪些用途');
    expect(d?.platformUserId).toBe('staff_1');
    expect(d?.replyContext.conversationId).toBe('cid_1');
  });

  it('非文本消息返回 null', () => {
    const codec = new DingTalkCodec(config);
    expect(codec.decode(req({ msgtype: 'picture' }))).toBeNull();
  });
});

/* ------------------------------ 企业微信 ------------------------------ */

describe('企业微信适配器', () => {
  const config = { corpId: 'c', agentId: 'a', secret: 's', token: 'tk', encodingAesKey: 'ek' };

  it('SHA-1 验签正确时通过', () => {
    const codec = new WecomCodec(config);
    const ts = '1700000000';
    const nonce = 'n1';
    const sig = createHash('sha1')
      .update([config.token, ts, nonce].sort().join(''), 'utf8')
      .digest('hex');
    expect(codec.verify(req({}, { msg_signature: sig, timestamp: ts, nonce }))).toBe(true);
  });

  it('验签错误时拒绝', () => {
    const codec = new WecomCodec(config);
    expect(codec.verify(req({}, { msg_signature: 'bad', timestamp: '1', nonce: '2' }))).toBe(false);
  });

  it('解码 XML 文本消息', () => {
    const codec = new WecomCodec(config);
    const xml = `<xml>
      <ToUserName><![CDATA[corp]]></ToUserName>
      <FromUserName><![CDATA[user_1]]></FromUserName>
      <MsgType><![CDATA[text]]></MsgType>
      <Content><![CDATA[甲企业9月金额]]></Content>
      <MsgId>123456</MsgId>
    </xml>`;
    const d = codec.decode(req({}, {}, xml));
    expect(d?.text).toBe('甲企业9月金额');
    expect(d?.platformUserId).toBe('user_1');
    expect(d?.messageId).toBe('123456');
  });

  it('非文本 XML 返回 null', () => {
    const codec = new WecomCodec(config);
    const xml = '<xml><MsgType><![CDATA[image]]></MsgType></xml>';
    expect(codec.decode(req({}, {}, xml))).toBeNull();
  });

  it('编码回复为 XML', () => {
    const codec = new WecomCodec(config);
    const out = codec.encode({ kind: 'done', text: '合计 9,622.06 元' });
    expect(out).toContain('9,622.06');
    expect(out).toContain('<Content>');
  });
});

/* ------------------------------ QQ 官方 ------------------------------ */

describe('QQ 官方适配器', () => {
  const config = { appId: 'a', appSecret: 's', token: 'tk', publicKeyHex: '' };

  it('op:13 验证请求无需签名', () => {
    const codec = new QQOfficialCodec(config);
    expect(codec.verify(req({ op: 13 }))).toBe(true);
  });

  it('op:13 返回 plain_token', async () => {
    const { QQOfficialPlatform } = await import('../src/platform/adapters/qq-official.js');
    const p = new QQOfficialPlatform(config);
    const r = await p.handleWebhookSafe(req({ op: 13, d: { plain_token: 'pt_1' } }));
    expect((r.body as { plain_token: string }).plain_token).toBe('pt_1');
  });

  it('缺少签名头时拒绝', () => {
    const codec = new QQOfficialCodec(config);
    expect(codec.verify(req({ op: 0, t: 'AT_MESSAGE_CREATE' }))).toBe(false);
  });

  it('解码群 @ 消息', () => {
    const codec = new QQOfficialCodec(config);
    const d = codec.decode(
      req({
        op: 0,
        t: 'GROUP_AT_MESSAGE_CREATE',
        id: 'qq_msg_1',
        d: {
          content: ' 甲企业9月金额 ',
          author: { id: 'qq_user_1' },
          group_openid: 'g_1',
        },
      }),
    );
    expect(d?.text).toBe('甲企业9月金额');
    expect(d?.platformUserId).toBe('qq_user_1');
    expect(d?.replyContext.groupOpenid).toBe('g_1');
  });

  it('非 @ 消息返回 null', () => {
    const codec = new QQOfficialCodec(config);
    expect(codec.decode(req({ op: 0, t: 'MESSAGE_CREATE' }))).toBeNull();
  });

  it('Ed25519 公钥格式非法时不崩溃', () => {
    const codec = new QQOfficialCodec({ ...config, publicKeyHex: 'zz' });
    expect(
      codec.verify(req({ op: 0 }, { 'x-signature-ed25519': '00', 'x-signature-timestamp': '1' })),
    ).toBe(false);
  });
});

/* ---------------------------- 平台覆盖度 ---------------------------- */

describe('平台适配器覆盖', () => {
  it('A 档四个平台全部有实现', async () => {
    const mod = await import('../src/platform/adapters/index.js');
    for (const name of [
      'LarkPlatform',
      'DingTalkPlatform',
      'WecomPlatform',
      'QQOfficialPlatform',
    ]) {
      expect(mod).toHaveProperty(name);
    }
  });

  it('每个适配器都有 meta()', () => {
    const p = new LarkPlatform({ appId: 'a', appSecret: 's' });
    expect(p.meta().type).toBe('lark');
    expect(p.meta().desc).toContain('飞书');
  });

  it('start/stop 改变状态', async () => {
    const p = new LarkPlatform({ appId: 'a', appSecret: 's' });
    expect(p.status).toBe('pending');
    await p.start();
    expect(p.status).toBe('running');
    await p.stop();
    expect(p.status).toBe('stopped');
  });
});

/* -------------------------------- Slack -------------------------------- */

describe('Slack 适配器', () => {
  const config = { signingSecret: 'slack_secret_123' };

  it('URL 验证返回 challenge', async () => {
    const { SlackPlatform } = await import('../src/platform/adapters/slack.js');
    const p = new SlackPlatform(config);
    const r = await p.handleWebhookSafe({
      headers: {
        'x-slack-signature': 'v0=test',
        'x-slack-request-timestamp': String(Math.floor(Date.now() / 1000)),
      },
      body: { type: 'url_verification', challenge: 'slack_ch_888' },
      rawBody: '{"type":"url_verification"}',
    });
    // URL 验证免签
    expect(r.status).toBe(200);
    expect((r.body as { challenge: string }).challenge).toBe('slack_ch_888');
  });

  it('防重放：时间戳过旧拒绝', async () => {
    const { SlackCodec } = await import('../src/platform/adapters/slack.js');
    const codec = new SlackCodec(config);
    const oldTs = String(Math.floor(Date.now() / 1000) - 600);
    const r = codec.verify({
      headers: {
        'x-slack-signature': 'v0=any',
        'x-slack-request-timestamp': oldTs,
      },
      body: {},
      rawBody: '{}',
    });
    expect(r).toBe(false);
  });

  it('解码普通文本消息', async () => {
    const { SlackCodec } = await import('../src/platform/adapters/slack.js');
    const codec = new SlackCodec(config);
    const decoded = codec.decode({
      headers: {},
      body: {
        type: 'event_callback',
        event: {
          type: 'message',
          user: 'U_SLACK_1',
          text: '甲企业 9 月金额统计',
          ts: '1700000001.000100',
          channel: 'C_FINANCE',
        },
      },
      rawBody: '',
    });

    expect(decoded?.platformUserId).toBe('U_SLACK_1');
    expect(decoded?.text).toBe('甲企业 9 月金额统计');
    expect(decoded?.replyContext.channel).toBe('C_FINANCE');
  });
});

/* ------------------------------- Discord ------------------------------- */

describe('Discord 适配器', () => {
  const config = { applicationId: 'app_1', botToken: 'tok_1', publicKeyHex: '' };

  it('PING (type 1) 响应 PONG (type 1)', async () => {
    const { DiscordPlatform } = await import('../src/platform/adapters/discord.js');
    const p = new DiscordPlatform(config);
    const r = await p.handleWebhookSafe({
      headers: {
        'x-signature-ed25519': 'sig',
        'x-signature-timestamp': 'ts',
      },
      body: { type: 1 },
      rawBody: '{"type":1}',
    });
    expect(r.status).toBe(200);
    expect((r.body as { type: number }).type).toBe(1);
  });

  it('解码交互命令消息', async () => {
    const { DiscordCodec } = await import('../src/platform/adapters/discord.js');
    const codec = new DiscordCodec(config);
    const decoded = codec.decode({
      headers: {},
      body: {
        type: 2,
        id: 'int_123',
        channel_id: 'ch_456',
        user: { id: 'disc_user_99' },
        data: {
          name: 'query',
          options: [{ name: 'month', value: '2026-09' }],
        },
      },
      rawBody: '',
    });

    expect(decoded?.platformUserId).toBe('disc_user_99');
    expect(decoded?.text).toBe('2026-09');
    expect(decoded?.replyContext.channelId).toBe('ch_456');
  });
});
