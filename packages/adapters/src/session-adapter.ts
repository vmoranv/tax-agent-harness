/**
 * 会话历史端口适配器（runtime `HarnessDeps.session` 的实现）。
 *
 * 把 `SessionRepository` 包装成 Harness 期望的两个回调：
 * - `history(sessionKey, limit)` → 最近 N 条对话
 * - `append(sessionKey, role, content)` → 追加一轮
 *
 * `sessionKey` 来自 `MessageEvent.umo.toString()`，如 `api:http:U001-C001`；
 * 从中解析 userId / enterpriseId 后落到 (user, enterprise) 隔离的会话上。
 *
 * 评测隔离（2026-11-05 修复 data leakage）：`api:http:eval-*` 这类显式会话
 * 走「无历史」通道 —— history 返回空、append 不落库。评测每条用例不该读到
 * 过往轮次答案、也不该把答案写进默认会话。在线默认会话行为完全不变。
 */

import type { UnitOfWork } from '@harness/contracts';
import { parseIsoDate } from '@harness/domain';

export interface SessionHistoryPort {
  readonly history: (
    sessionKey: string,
    limit: number,
  ) => Promise<ReadonlyArray<{ role: 'user' | 'assistant'; content: string }>>;
  readonly append: (
    sessionKey: string,
    role: 'user' | 'assistant',
    content: string,
  ) => Promise<void>;
}

function parseKey(sessionKey: string): { userId: string; enterpriseId: string } {
  return {
    userId: sessionKey.match(/U\d{3}/)?.[0] ?? 'U001',
    enterpriseId: sessionKey.match(/C\d{3}/)?.[0] ?? 'C001',
  };
}

/** 评测隔离会话：umo sessionId 以 `eval-` 开头（由 /api/chat 的可选 sessionId 注入）。 */
function isIsolatedEvalSession(sessionKey: string): boolean {
  const sessionIdPart = sessionKey.slice(sessionKey.lastIndexOf(':') + 1);
  return sessionIdPart.startsWith('eval-');
}

export function createSessionAdapter(uow: UnitOfWork): SessionHistoryPort {
  /**
   * 单次事务内完成「找/建会话 + 读写消息」。
   *
   * 早期实现分两次 `uow.run`，在 SQLite 上会因 `BEGIN IMMEDIATE` 嵌套而失败
   * （连接是单例，`node:sqlite` 不支持嵌套事务）。合并成一次事务后：
   * - SQLite：一个 BEGIN/COMMIT
   * - PostgreSQL：一个连接的事务快照，语义一致
   */
  return {
    async history(sessionKey, limit) {
      // 评测隔离会话：无历史、不触碰默认 (user,enterprise) 会话。
      if (isIsolatedEvalSession(sessionKey)) return [];
      const { userId: uid, enterpriseId: eid } = parseKey(sessionKey);
      const nowIso = new Date().toISOString();
      return uow.run(async (tx) => {
        const session = await tx.sessions.findOrCreate(
          uid as never,
          eid as never,
          parseIsoDate(nowIso.slice(0, 10)),
        );
        const msgs = await tx.sessions.listMessages(session.id, limit);
        return msgs
          .filter((m) => m.role === 'user' || m.role === 'assistant')
          .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));
      });
    },

    async append(sessionKey, role, content) {
      // 评测隔离会话：不落库，避免把答案写进默认会话造成后续污染。
      if (isIsolatedEvalSession(sessionKey)) return;
      const { userId: uid, enterpriseId: eid } = parseKey(sessionKey);
      const nowIso = new Date().toISOString();
      await uow.run(async (tx) => {
        const session = await tx.sessions.findOrCreate(
          uid as never,
          eid as never,
          parseIsoDate(nowIso.slice(0, 10)),
        );
        await tx.sessions.appendMessage(session.id, role, content, nowIso as never);
      });
    },
  };
}
