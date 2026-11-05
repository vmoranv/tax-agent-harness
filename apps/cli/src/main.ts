#!/usr/bin/env node

/**
 * CLI 入口。
 *
 * 命令设计原则：**演示要能一步步看清**，不做花哨的交互。
 * `harness ask` 是最常用的：一句话问答，输出后附上本轮 trace 摘要。
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { enterpriseId, userId } from '@harness/domain';
import { createTools, log, MessageEvent, runScripted, Umo } from '@harness/runtime';
import { Command } from 'commander';
import { type App, bootstrap } from './bootstrap.js';
import { type AppConfig, loadConfig } from './config.js';
import { loadEnv } from './env.js';

// 加载仓库根 .env（含 HARNESS_LLM_API_KEY），须在任何 process.env 读取之前。
loadEnv();

const program = new Command();

program.name('harness').description('财税 Agent Harness').version('0.1.0');

/* ---------------------------- db init ---------------------------- */

program
  .command('db')
  .description('数据库管理')
  .argument('<action>', 'init | reset | info')
  .option('--db <path>', '数据库路径', './data/runtime/harness.db')
  .option('--xlsx <path>', '原始数据文件', './fixtures/excel/02_示例数据.xlsx')
  .option('--rules <path>', '规则种子文件', './fixtures/rules.seed.json')
  .action(async (action: string, opts: Record<string, string>) => {
    if (action === 'reset') {
      const { rmSync } = await import('node:fs');
      rmSync(opts['db'] ?? '', { force: true });
      log.info('已删除数据库，将重新创建');
    }
    const app = await bootstrap({
      config: withDbPath(opts['db']),
      seed: true,
      ...(opts['xlsx'] === undefined ? {} : { datasetPath: opts['xlsx'] }),
      ...(opts['rules'] === undefined ? {} : { rulesPath: opts['rules'] }),
      verbose: true,
    });
    // 等待 close() 完成，避免悬空 Promise 与进程提前退出（建表/seed 已在 bootstrap 内完成）。
    await app.close();
  });

/* ------------------------------ ask ------------------------------ */

program
  .command('ask')
  .description('单轮提问（无模型时可用 --script 演示）')
  .argument('<text>', '要问的话')
  .option('--user <id>', '用户编号', 'U001')
  .option('--enterprise <id>', '企业编号', 'C001')
  .option('--db <path>', '数据库路径', './data/runtime/harness.db')
  .option('--script <path>', '脚本化回合（JSON），不调模型')
  .option('--trace', '打印本轮运行记录摘要', false)
  .action(async (text: string, opts: Record<string, unknown>) => {
    const app = await bootstrap({
      config: withDbPath(opts['db'] === undefined ? undefined : String(opts['db'])),
      verbose: true,
    });

    try {
      const event = new MessageEvent(
        Umo.of('cli', 'local', `${String(opts['user'])}-${String(opts['enterprise'])}`),
        {
          userId: userId(String(opts['user'])),
          enterpriseId: enterpriseId(String(opts['enterprise'])),
          text,
          messageId: `m_${Date.now()}`,
          receivedAt: new Date().toISOString(),
        },
      );

      const platform = app.platforms.get('cli');

      if (opts['script'] !== undefined) {
        await runScript(app, event, String(opts['script']), platform);
      } else {
        const result = await app.harness.handle(event, platform);
        if (opts['trace'] === true) printTrace(app, result.runId);
      }
    } finally {
      await app.close();
    }
  });

/* ------------------------------ demo ------------------------------ */

program
  .command('demo')
  .description('跑完整演示（脚本化，不依赖模型）')
  .option('--db <path>', '数据库路径', './data/runtime/harness.db')
  .action(async (opts: Record<string, unknown>) => {
    const app = await bootstrap({
      config: withDbPath(opts['db'] === undefined ? undefined : String(opts['db'])),
      verbose: true,
    });
    try {
      await runDemo(app);
    } finally {
      await app.close();
    }
  });

/* ----------------------------- trace ----------------------------- */

program
  .command('trace')
  .description('查看运行记录')
  .argument('[runId]', '留空则列出最近几条')
  .option('--db <path>', '数据库路径', './data/runtime/harness.db')
  .action(async (runId: string | undefined, opts: Record<string, unknown>) => {
    const app = await bootstrap({
      config: withDbPath(opts['db'] === undefined ? undefined : String(opts['db'])),
    });
    try {
      const rows = app.container.db
        .prepare(
          'SELECT run_id, started_at, final_preview FROM trace_run ORDER BY started_at DESC LIMIT 20',
        )
        .all() as Array<Record<string, unknown>>;

      if (runId === undefined) {
        for (const r of rows) {
          console.log(
            `${String(r['run_id']).padEnd(28)} ${String(r['started_at'])}  ${String(r['final_preview']).slice(0, 40)}`,
          );
        }
        return;
      }
      printTrace(app, runId);
    } finally {
      await app.close();
    }
  });

/* ----------------------------- doctor ----------------------------- */

program
  .command('doctor')
  .description('环境自检')
  .action(async () => {
    console.log('Node', process.version);
    const { DatabaseSync } = await import('node:sqlite');
    console.log('node:sqlite', typeof DatabaseSync === 'function' ? '✓' : '✗');

    const baseUrl = process.env['HARNESS_LLM_BASE_URL'] ?? '';
    const apiKey = process.env['HARNESS_LLM_API_KEY'] ?? '';
    if (baseUrl === '') {
      console.log('LLM 端点  未配置（可用 --script 演示）');
    } else {
      console.log('LLM 端点', baseUrl);
      console.log('LLM 密钥', apiKey === '' ? '✗ 未配置' : '✓ 已配置');
    }
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});

/* ---------------------------- 辅助函数 ---------------------------- */

/** 命令行 --db 覆盖配置里的 sqlitePath。 */
function withDbPath(dbPath: string | undefined): AppConfig {
  const base = loadConfig();
  return dbPath === undefined ? base : { ...base, sqlitePath: dbPath };
}

/**
 * 脚本化执行：不调模型，按预设回合驱动工具。
 *
 * 用途有两个：CI 里跑三场景，以及演示时 API 不可用时的兜底。
 */
async function runScript(
  app: App,
  event: MessageEvent,
  scriptPath: string,
  platform: { send: (e: MessageEvent, c: { kind: 'done'; text: string }) => Promise<void> },
): Promise<void> {
  const raw = JSON.parse(readFileSync(resolve(scriptPath), 'utf8')) as {
    turns: Array<
      Array<{ type: 'text' | 'tool-call'; content?: string; name?: string; args?: unknown }>
    >;
  };

  const tools = createTools({ app: app.facade, nextToolCallId: () => 'c' });
  const result = await runScripted(
    {
      tools,
      toolContext: {
        runId: 'script',
        toolCallId: 'c',
        userId: event.userId,
        enterpriseId: event.enterpriseId,
      },
      onToolResult: ({ name, result: r }) => {
        // 打印工具真实返回，便于核对「数字确实来自程序」
        const body = r.ok
          ? JSON.stringify(r.data, null, 2)
          : `✗ ${r.error.code}: ${r.error.message}`;
        console.log(`
  [工具 ${name}]
${body}`);
      },
    },
    raw.turns,
  );
  await platform.send(event, { kind: 'done', text: result.text });
}

async function runDemo(app: App): Promise<void> {
  console.log('\n=== 1. 查询甲企业 2026-09 金额 ===');
  await ask(app, 'U001', 'C001', '甲企业 2026 年 9 月的发票和银行收支各是多少');

  console.log('\n=== 2. 检查乙企业 2026-09 缺项（核心陷阱：3 张不是 6 张）===');
  await ask(app, 'U001', 'C002', '乙企业 9 月有哪些发票没填用途');

  console.log('\n=== 3. 补充保存 ===');
  await ask(app, 'U001', 'C001', '把甲企业 F002 的用途填成「办公用品采购」');

  console.log('\n=== 4. 权限拒绝 ===');
  await ask(app, 'U002', 'C001', '把 F003 的用途填成「快递费」');
}

async function ask(app: App, user: string, ent: string, text: string): Promise<void> {
  const event = new MessageEvent(Umo.of('cli', 'local', `${user}-${ent}`), {
    userId: userId(user),
    enterpriseId: enterpriseId(ent),
    text,
    messageId: `m_${Date.now()}`,
    receivedAt: new Date().toISOString(),
  });
  const r = await app.harness.handle(event, app.platforms.get('cli'));
  console.log(`  → ${r.text}`);
}

function printTrace(app: App, runId: string): void {
  const row = app.container.db
    .prepare('SELECT payload FROM trace_run WHERE run_id = ?')
    .get(runId) as { payload: string } | undefined;
  if (row === undefined) {
    console.log('未找到该 run');
    return;
  }
  const t = JSON.parse(row.payload) as {
    context: { rules: Array<{ code: string; version: string }>; estimatedTokens: number } | null;
    steps: Array<{ kind: string; payload: unknown }>;
    toolCalls: Array<{ name: string; ok: boolean }>;
    provenance: Array<{ literal: string; source: string; ok: boolean }>;
    finalText: string;
  };
  console.log('\n--- 运行记录 ---');
  console.log(
    '注入规则:',
    t.context?.rules.map((r) => `${r.code}@${r.version}`).join(', ') ?? '（无）',
  );
  console.log('估算 token:', t.context?.estimatedTokens ?? 0);
  console.log(
    '工具调用:',
    t.toolCalls.map((c) => `${c.name}${c.ok ? '✓' : '✗'}`).join(', ') || '（无）',
  );
  console.log(
    '数字溯源:',
    t.provenance.map((p) => `${p.literal}→${p.source}`).join(', ') || '（无）',
  );
  console.log('最终回复:', t.finalText);
}
