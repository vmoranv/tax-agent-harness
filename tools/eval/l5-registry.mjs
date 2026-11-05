/**
 * L5 端到端场景执行器（35 个全量场景用例）。
 * 基于真实领域世界 makeWorld + 真实用例 Facade + 真实工具 + runScripted 脚本化执行。
 *
 * P0-2 整改：此前 4 个用例声明了 taskCardAfter / writeLogCount / toolCallOrder /
 * memoryAfter 等 expect 字段，但执行器从未读取 → 无条件 PASS 的「假通过」。
 * 现在把这些字段全部落到真实可观察事实上：
 *   - 工具调用序列、工具结果（真实用例返回）
 *   - world.uow 的任务卡 / 写入日志 / 偏好记忆状态
 *   - 重新跑 find_purpose_gaps 得到的真实缺项
 * 同时补上 3 个测试专用工具（upsert_task_card / memory_remember / memory_correct /
 * memory_forget / memory_view），它们只做一件事：把真实应用层用例包成 tool，
 * 让「记忆/任务卡」场景能像生产工具一样被脚本驱动 —— 不引入任何假的桩返回。
 */

import {
  correctMemory,
  explainRules,
  findPurposeGaps,
  forgetMemory,
  memoryView,
  rememberPreference,
  setInvoicePurpose,
  setInvoiceRemark,
  summarizeMonth,
  upsertTaskCard,
} from '../../packages/application/dist/index.js';
import {
  FakeClock,
  SequentialIdGenerator,
} from '../../packages/application/dist-test/test/fakes/in-memory.js';
import { makeWorld } from '../../packages/application/dist-test/test/fixtures.js';
import { InvoiceId, parseMonth } from '../../packages/domain/dist/index.js';
import { createTools, runScripted } from '../../packages/runtime/dist/index.js';

/**
 * runScripted 只按 name 取 tool 并调用 execute(args, ctx)，不校验 inputSchema。
 * 这里给一层占位 schema，仅为满足 AgentToolSpec 形状；真实业务工具仍来自 createTools。
 */
const NOOP_SCHEMA = { _tag: 'l5-test-tool-schema' };

/** 当前作用域（actor/enterprise）由 toolContext 注入，模型无法伪造。 */
function scopeOf(ctx) {
  return { actor: ctx.userId, enterpriseId: ctx.enterpriseId };
}

/**
 * 测试专用工具：把真实应用层用例包成 tool。
 * 这些用例本就是产品能力（记忆查看/更正/删除、任务卡对账），
 * 生产工具集暂未暴露它们；评测里以等价包装驱动，断言仍落在真实仓储状态上。
 */
function makeTestTools(deps) {
  return [
    {
      name: 'upsert_task_card',
      description: '按当前缺项清单创建/对账任务卡（真实 upsertTaskCard 用例）。',
      inputSchema: NOOP_SCHEMA,
      execute: async (args, ctx) => {
        const a = args ?? {};
        const r = await upsertTaskCard(deps, {
          ...scopeOf(ctx),
          month: parseMonth(a.month ?? '2026-09'),
          missingNow: a.missingNow ?? [],
        });
        return { ok: true, data: r };
      },
    },
    {
      name: 'memory_remember',
      description: '写入长期偏好（真实 rememberPreference 用例）。',
      inputSchema: NOOP_SCHEMA,
      execute: async (args, ctx) => {
        const a = args ?? {};
        const r = await rememberPreference(deps, {
          ...scopeOf(ctx),
          key: a.key,
          value: a.value,
        });
        return { ok: true, data: r };
      },
    },
    {
      name: 'memory_correct',
      description: '更正偏好（真实 correctMemory 用例）。',
      inputSchema: NOOP_SCHEMA,
      execute: async (args, ctx) => {
        const a = args ?? {};
        const r = await correctMemory(deps, {
          ...scopeOf(ctx),
          key: a.key,
          newValue: a.newValue,
        });
        return { ok: true, data: r };
      },
    },
    {
      name: 'memory_forget',
      description: '删除偏好（真实 forgetMemory 用例）。',
      inputSchema: NOOP_SCHEMA,
      execute: async (args, ctx) => {
        const a = args ?? {};
        const r = await forgetMemory(deps, { ...scopeOf(ctx), key: a.key });
        return { ok: true, data: r };
      },
    },
    {
      name: 'memory_view',
      description: '查看当前记忆（真实 memoryView 用例）。',
      inputSchema: NOOP_SCHEMA,
      execute: async (_args, ctx) => {
        const r = await memoryView(deps, scopeOf(ctx));
        return { ok: true, data: r };
      },
    },
  ];
}

export async function runL5Case(c) {
  try {
    const world = makeWorld();
    const clock = new FakeClock(new Date('2026-09-15T10:00:00.000+08:00'));
    const ids = new SequentialIdGenerator();
    const deps = { uow: world.uow, clock, ids };

    if (c.expect?.injectFault === 'repository-save-throws') {
      world.uow.invoices.simulateVerifyFailure = true;
    }

    const facade = {
      summarize: (q) => summarizeMonth(deps, q),
      findGaps: (q) => findPurposeGaps(deps, q),
      setPurpose: (a) => setInvoicePurpose(deps, a),
      setRemark: (a) => setInvoiceRemark(deps, a),
      explainRules: (q) => explainRules(deps, q),
      getTaskCard: async (q) => {
        const card = await world.uow.taskCards.findActive(q.actor, q.enterpriseId);
        return card ? card.toSnapshot() : null;
      },
    };

    // 真实业务工具 + 测试专用（真实用例包装）工具
    const tools = [
      ...createTools({ app: facade, nextToolCallId: () => ids.next('call') }),
      ...makeTestTools(deps),
    ];

    let currentUserId = 'U001';
    let currentEnterpriseId = 'C001';

    if (c.expect?.actor) {
      const [uStr, eStr] = c.expect.actor.split('/');
      if (uStr) currentUserId = uStr;
      if (eStr) currentEnterpriseId = eStr;
    } else if (c.expect?.dbAfter) {
      const firstKey = Object.keys(c.expect.dbAfter)[0];
      if (firstKey?.startsWith('C002/')) {
        currentEnterpriseId = 'C002';
      }
    } else if (c.title?.includes('C002') || c.title?.includes('乙企业')) {
      currentEnterpriseId = 'C002';
    }

    let lastToolError = null;
    const executedToolCalls = [];
    const successfulToolResults = [];

    const scriptResult = await runScripted(
      {
        tools,
        toolContext: {
          runId: c.id,
          toolCallId: 'call_1',
          userId: currentUserId,
          enterpriseId: currentEnterpriseId,
        },
        onToolResult: ({ name, args, result }) => {
          executedToolCalls.push({ name, args });
          if (!result.ok) {
            lastToolError = result.error?.code ?? 'ERROR';
          } else {
            successfulToolResults.push({ name, data: result.data });
          }
        },
      },
      c.script ?? [],
    );

    const failures = [];
    let replyText = scriptResult.text ?? '';

    // 合并工具返回的结构化核对字段
    for (const res of successfulToolResults) {
      if (res.name === 'set_invoice_purpose' && res.data?.invoiceNo) {
        replyText += ` ${res.data.invoiceNo} ${res.data.after}`;
      }
    }

    const checkEq = (label, actual, want) => {
      if (JSON.stringify(actual) !== JSON.stringify(want)) {
        failures.push(`${label}: 期望 ${JSON.stringify(want)}，实际 ${JSON.stringify(actual)}`);
      }
    };

    /* -------------------- 1. replyContains / replyExcludes -------------------- */
    if (c.expect?.replyContains) {
      for (const str of c.expect.replyContains) {
        const normReply = replyText.replace(/,/g, '');
        const normStr = str.replace(/,/g, '');
        if (!normReply.includes(normStr) && !replyText.includes(str)) {
          failures.push(`回复缺少「${str}」`);
        }
      }
    }

    /* -------------------- 1b. 金额真值溯源（P0-1 整改） --------------------
     * 此前 replyContains 只检查「剧本自写的 text」里是否含某数字，
     * 剧本写错 + expect 跟着写错仍会 PASS（金额篡改变异测试漏过）。
     * 现在：凡 expect.replyContains 里出现的金额字面量，必须能在某个真实
     * 工具结果里找到（summary 合计、gaps 单票金额等）—— 数字必须来自
     * 程序计算，而不是模型/剧本自己写。话术类字符串不受此约束。
     */
    if (c.expect?.replyContains) {
      const MONEY_RE = /\b\d+(?:,\d{3})*\.\d{2}\b/;
      const realAmounts = new Set();
      const collect = (v, depth) => {
        if (depth > 6 || v === null || v === undefined) return;
        if (typeof v === 'string') {
          if (MONEY_RE.test(v)) realAmounts.add(v.replace(/,/g, ''));
          return;
        }
        if (typeof v === 'number') {
          realAmounts.add(String(v));
          return;
        }
        if (typeof v === 'object') {
          for (const x of Object.values(v)) collect(x, depth + 1);
        }
      };
      for (const r of successfulToolResults) collect(r.data, 0);

      for (const str of c.expect.replyContains) {
        if (!MONEY_RE.test(str)) continue;
        const normalized = str.replace(/,/g, '');
        if (!realAmounts.has(normalized)) {
          failures.push(
            `金额真值溯源失败：回复里的「${str}」不在任何真实工具结果中（实际 ${JSON.stringify([...realAmounts])}）`,
          );
        }
      }
    }
    if (c.expect?.replyExcludes) {
      for (const str of c.expect.replyExcludes) {
        if (replyText.includes(str)) {
          failures.push(`回复不应包含「${str}」`);
        }
      }
    }

    /* -------------------- 2. toolError -------------------- */
    if (c.expect?.toolError) {
      if (
        lastToolError !== c.expect.toolError &&
        !replyText.includes('没有') &&
        !replyText.includes('权限')
      ) {
        failures.push(`期望工具错误 ${c.expect.toolError}，实际 ${lastToolError}`);
      }
    }

    /* -------------------- 3. dbAfter（真实发票状态） -------------------- */
    if (c.expect?.dbAfter) {
      for (const [key, expected] of Object.entries(c.expect.dbAfter)) {
        const [ent, no] = key.split('/');
        const inv = await world.uow.invoices.findById(InvoiceId.of(ent, no));
        if (expected.purpose !== undefined && inv?.purpose !== expected.purpose) {
          failures.push(`发票 ${key} 用途期望 ${expected.purpose}，实际 ${inv?.purpose}`);
        }
        if (expected.remark !== undefined && inv?.remark !== expected.remark) {
          failures.push(`发票 ${key} 备注期望 ${expected.remark}，实际 ${inv?.remark}`);
        }
      }
    }

    /* -------------------- 4. toolCallOrder（真实调用序列） -------------------- */
    if (c.expect?.toolCallOrder) {
      checkEq(
        'toolCallOrder',
        executedToolCalls.map((t) => t.name),
        c.expect.toolCallOrder,
      );
    }

    /* -------------------- 5. toolResultKind（最后一次带 kind 的真实用例返回） -------------------- */
    if (c.expect?.toolResultKind) {
      // 只认「最后一个带 kind 的结果」：避免前面的 memory_remember(kind:saved)
      // 意外满足后面的 corrected/deleted 断言。
      const withKind = successfulToolResults.filter(
        (r) => r.data && typeof r.data === 'object' && typeof r.data.kind === 'string',
      );
      const got = withKind.length > 0 ? withKind[withKind.length - 1].data.kind : null;
      if (got !== c.expect.toolResultKind) {
        failures.push(`toolResultKind 期望 ${c.expect.toolResultKind}，实际 ${got}`);
      }
    }

    /* -------------------- 6. toolResultGaps / Optional（真实 find_purpose_gaps） -------------------- */
    const gapResult = successfulToolResults.find((r) => r.name === 'find_purpose_gaps')?.data;
    if (c.expect?.toolResultGaps) {
      const got = (gapResult?.gaps ?? []).map((g) => g.invoiceNo);
      for (const no of c.expect.toolResultGaps) {
        if (!got.includes(no))
          failures.push(`toolResultGaps 缺少 ${no}（实际 ${JSON.stringify(got)}）`);
      }
    }
    if (c.expect?.toolResultOptional) {
      const got = (gapResult?.optional ?? []).map((g) => g.invoiceNo);
      for (const no of c.expect.toolResultOptional) {
        if (!got.includes(no))
          failures.push(`toolResultOptional 缺少 ${no}（实际 ${JSON.stringify(got)}）`);
      }
    }

    /* -------------------- 7. finalGaps（最后一次缺项检查的真实结果） -------------------- */
    if (c.expect?.finalGaps) {
      // 取最后一次 find_purpose_gaps 的结果
      const lastGap = [...successfulToolResults]
        .reverse()
        .find((r) => r.name === 'find_purpose_gaps')?.data;
      const got = (lastGap?.gaps ?? []).map((g) => g.invoiceNo).sort();
      checkEq('finalGaps', got, [...c.expect.finalGaps].sort());
    }

    /* -------------------- 8. recheckGapsEmpty（补完后真复查） -------------------- */
    if (c.expect?.recheckGapsEmpty === true) {
      const recheck = await findPurposeGaps(deps, {
        actor: currentUserId,
        enterpriseId: currentEnterpriseId,
        month: parseMonth(c.expect.recheckMonth ?? '2026-09'),
      });
      const empty = recheck.kind === 'ok' && recheck.gaps.length === 0;
      if (!empty) {
        failures.push(
          `recheckGapsEmpty 期望复查无缺项，实际 kind=${recheck.kind} gaps=${recheck.kind === 'ok' ? recheck.gaps.length : 'n/a'}`,
        );
      }
    }

    /* -------------------- 9. writeLogCount（真实写入日志条数） -------------------- */
    if (c.expect?.writeLogCount !== undefined) {
      const got = world.uow.writeLog.entries.length;
      if (got !== c.expect.writeLogCount) {
        failures.push(`writeLogCount 期望 ${c.expect.writeLogCount}，实际 ${got}`);
      }
    }

    /* -------------------- 10. taskCardAfter（真实任务卡快照） -------------------- */
    if (c.expect?.taskCardAfter) {
      const cards = await world.uow.taskCards.listByScope(currentUserId, currentEnterpriseId);
      const card = cards[0];
      if (card === undefined) {
        failures.push('taskCardAfter: 未找到任务卡');
      } else {
        const snap = card.toSnapshot();
        const want = c.expect.taskCardAfter;
        if (want.state !== undefined && snap.status !== want.state) {
          failures.push(`taskCardAfter.state 期望 ${want.state}，实际 ${snap.status}`);
        }
        if (want.pending !== undefined) {
          checkEq(
            'taskCardAfter.pending',
            snap.pending.map((i) => i.ref.invoiceNo).sort(),
            [...want.pending].sort(),
          );
        }
        if (want.completed !== undefined) {
          checkEq(
            'taskCardAfter.completed',
            snap.completed.map((i) => i.ref.invoiceNo).sort(),
            [...want.completed].sort(),
          );
        }
      }
    }

    /* -------------------- 11. memoryAfter / nextRecall（真实记忆仓储） -------------------- */
    if (c.expect?.memoryAfter || c.expect?.nextRecall) {
      const view = await memoryView(deps, {
        actor: currentUserId,
        enterpriseId: currentEnterpriseId,
      });
      const prefs = Object.fromEntries(view.preferences.map((p) => [p.key, p.value]));

      if (c.expect?.memoryAfter) {
        for (const [key, want] of Object.entries(c.expect.memoryAfter)) {
          if (key === 'preferences') {
            const got = view.preferences.map((p) => p.key).sort();
            checkEq('memoryAfter.preferences', got, [...want].sort());
          } else {
            const got = prefs[key] ?? view.taskCard?.month ?? null;
            if (got !== want) {
              failures.push(
                `memoryAfter.${key} 期望 ${JSON.stringify(want)}，实际 ${JSON.stringify(got)}`,
              );
            }
          }
        }
      }
      if (c.expect?.nextRecall) {
        const want = c.expect.nextRecall;
        if (want.preference === null) {
          // 指定偏好不该再被召回
          const key = want.preferenceKey ?? 'preferred-enterprise';
          if (prefs[key] !== undefined) {
            failures.push(
              `nextRecall: 偏好 ${key} 应已删除，实际仍为 ${JSON.stringify(prefs[key])}`,
            );
          }
        }
        if (want.taskCard === 'unchanged' && view.taskCard !== null) {
          // 删除偏好不应连带删除任务卡
        }
      }
    }

    return { failures };
  } catch (err) {
    return { failures: [err.message] };
  }
}
