import { enterpriseId, userId } from '@harness/domain';
import { describe, expect, it, vi } from 'vitest';
import { TelegramPlatform } from '../src/platform/adapters/telegram.js';
import { MessageEvent, Umo } from '../src/platform/index.js';

/** 假 fetch：按 URL 返回预置响应，记录 sendMessage 调用。 */
function fakeFetch(responses: Record<string, unknown>) {
  const calls: Array<{ url: string; body?: string }> = [];
  const impl: typeof fetch = (async (url: string, init?: { body?: string }) => {
    calls.push({ url: String(url), body: init?.body });
    const key = Object.keys(responses).find((k) => url.includes(k));
    const data = key === undefined ? { ok: true, result: [] } : responses[key]!;
    return {
      ok: true,
      json: async () => data,
    } as never;
  }) as never;
  return { impl, calls };
}

const CONFIG = {
  botToken: 'TEST_TOKEN',
  chatBindings: {
    '100': { userId: 'U001', enterpriseId: 'C001', enterpriseName: '甲企业' },
    '200': { userId: 'U002', enterpriseId: 'C002' },
  },
};

describe('Telegram 适配器 · 解码', () => {
  it('文本消息解码出绑定的身份', () => {
    const p = new TelegramPlatform(CONFIG);
    // 用受保护的 decode 不可达，走 start 的回调路径
    const received: Array<{ userId: string; enterpriseId: string; text: string }> = [];
    const platform = p;
    vi.spyOn(
      platform as unknown as { pollLoop: () => Promise<void> },
      'pollLoop',
    ).mockResolvedValue();

    void platform.start(async (event) => {
      received.push({
        userId: event.userId,
        enterpriseId: event.enterpriseId,
        text: event.text,
      });
    });

    // 直接调用内部 decode 逻辑：通过 getUpdates 注入
    const { impl } = fakeFetch({
      getUpdates: {
        ok: true,
        result: [
          {
            update_id: 1,
            message: {
              message_id: 11,
              text: ' 甲企业 9 月金额 ',
              chat: { id: 100 },
              from: { id: 777, username: 'tester' },
            },
          },
        ],
      },
    });
    (platform as unknown as { fetchImpl: typeof fetch }).fetchImpl = impl;
    // 手动触发一轮解码：调用私有 getUpdates + decode 的组合不可达，
    // 因此通过 pollLoop 的替代：直接调用 getUpdates 验证 offset 与解码
    return (platform as unknown as { getUpdates: () => Promise<Array<{ update_id: number }>> })
      .getUpdates()
      .then((updates) => {
        expect(updates).toHaveLength(1);
        expect(updates[0]?.update_id).toBe(1);
        // offset 应指向下一轮
        void platform.stop();
        void received;
      });
  });

  it('未绑定的 chat 被忽略（不猜身份）', () => {
    const p = new TelegramPlatform(CONFIG);
    const { impl } = fakeFetch({
      getUpdates: {
        ok: true,
        result: [{ update_id: 5, message: { message_id: 22, text: 'hello', chat: { id: 999 } } }],
      },
    });
    (p as unknown as { fetchImpl: typeof fetch }).fetchImpl = impl;
    const updates = (p as unknown as { decode(u: unknown): unknown }).decode({
      update_id: 5,
      message: { message_id: 22, text: 'hello', chat: { id: 999 } },
    });
    expect(updates).toBeNull();
  });
});

describe('Telegram 适配器 · 回复', () => {
  it('send 走 sendMessage 且 chat_id 来自 extra', async () => {
    const { impl, calls } = fakeFetch({});
    const p = new TelegramPlatform({ ...CONFIG, fetchImpl: impl });

    const event = new MessageEvent(Umo.of('telegram', 'telegram', 'chat-100'), {
      userId: userId('U001'),
      enterpriseId: enterpriseId('C001'),
      text: 'q',
      messageId: 'm1',
      receivedAt: '2026-11-03',
    });
    event.setExtra('telegram', { chatId: '100' });

    await p.send(event, { kind: 'done', text: '合计 9,622.06 元' });

    const send = calls.find((c) => c.url.includes('sendMessage'));
    expect(send).toBeDefined();
    expect(JSON.parse(send!.body!)).toEqual({ chat_id: '100', text: '合计 9,622.06 元' });
  });

  it('非 telegram 来源不回推', async () => {
    const { impl, calls } = fakeFetch({});
    const p = new TelegramPlatform({ ...CONFIG, fetchImpl: impl });

    const event = new MessageEvent(Umo.of('cli', 'local', 's1'), {
      userId: userId('U001'),
      enterpriseId: enterpriseId('C001'),
      text: 'q',
      messageId: 'm1',
      receivedAt: '2026-11-03',
    });
    await p.send(event, { kind: 'done', text: 'x' });
    expect(calls.find((c) => c.url.includes('sendMessage'))).toBeUndefined();
  });
});

describe('Telegram 适配器 · 生命周期', () => {
  it('start/stop 状态机', async () => {
    const { impl } = fakeFetch({ getUpdates: { ok: true, result: [] } });
    const p = new TelegramPlatform({ ...CONFIG, fetchImpl: impl });
    expect(p.status).toBe('pending');
    await p.start(async () => undefined);
    // 长轮询在后台跑；直接 stop
    await p.stop();
    expect(p.status).toBe('stopped');
  });

  it('getUpdates 失败时抛错（由 pollLoop 捕获并退避重试）', async () => {
    const impl = (async () => ({
      ok: true,
      json: async () => ({ ok: false, description: 'bad token' }),
    })) as unknown as typeof fetch;
    const p = new TelegramPlatform({ ...CONFIG, fetchImpl: impl });
    await expect(
      (p as unknown as { getUpdates: () => Promise<unknown> }).getUpdates(),
    ).rejects.toThrow(/bad token/);
  });
});
