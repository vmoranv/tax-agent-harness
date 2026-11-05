/**
 * 评测中台端点：执行评测引擎（tools/eval/run-eval.mjs --json）并返回结构化报告。
 *
 * 说明：评测引擎在存在 FAIL/UNVERIFIED 用例时会以退出码 1 结束，但这是「报告内容」
 * 而非进程故障——只要 stdout 是合法 JSON 就正常返回。真正的 spawn 失败
 * （进程无法启动、输出不是合法 JSON）才返回 500。
 */
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';

/** 与 Web 端 EvalReport 契约一致（见 apps/web/src/api/harness.ts）。 */
interface EvalReport {
  officialDimensions: Array<{ key: string; name: string; weight: number; look: string }>;
  disclaimer: string;
  golden: { ok: boolean; problems: string[] };
  total: number;
  byStatus: Record<string, number>;
  byLayer: Record<
    string,
    {
      total: number;
      pass: number;
      fail: number;
      blocked: number;
      pending: number;
      unverified: number;
      manual: number;
    }
  >;
  dimensions: Record<
    string,
    {
      name: string;
      desc: string;
      target: number;
      taggedCount: number;
      uniqueCases: number;
      pass: number;
      fail: number;
      score: number | null;
      health: string;
    }
  >;
  /** 真实 IR 检索指标（确定性规则检索，非向量）。 */
  retrieval: {
    available: boolean;
    reason?: string;
    macro: {
      precision: number;
      recall: number;
      f1: number;
      versionHitRate: number;
      queryCount: number;
      candidateCount: number;
      micro: { precision: number; recall: number; f1: number; tp: number; fp: number; fn: number };
    } | null;
    queries: Array<{
      enterprise: string;
      month: string;
      gold: string[];
      retrieved: string[];
      tp: number;
      fp: number;
      fn: number;
      precision: number;
      recall: number;
      f1: number;
      versionExact: boolean;
    }>;
    generatedAt?: string;
  };
  results: Array<{
    layer: string;
    id: string;
    title: string;
    status: string;
    failures: string[];
    dimensions: string[];
  }>;
}

const TTL_MS = 15_000;
const EVAL_SCRIPT = 'tools/eval/run-eval.mjs';
/** 解析失败时，stdout 用于错误详情的截断长度（字符数）。 */
const ERROR_STDOUT_PREVIEW = 200;

interface CacheEntry {
  ts: number;
  data: EvalReport;
}

let cache: CacheEntry | null = null;
// 并发去重：同一时刻只 spawn 一个评测进程，避免多请求叠加。
let inflight: Promise<EvalReport> | null = null;

/** 运行评测脚本并解析 stdout；进程故障/非法 JSON 时 reject。 */
function runEval(): Promise<EvalReport> {
  // server 从 repo root 启动，run-eval.mjs 的相对路径以此为基准。
  const cwd = resolve(process.cwd());
  return new Promise<EvalReport>((resolvePromise, reject) => {
    // 用 process.execPath 而非字面量 'node'，规避 Windows/PATH 差异。
    const child = spawn(process.execPath, [EVAL_SCRIPT, '--json'], {
      cwd,
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk;
    });

    child.on('error', (err) => {
      reject(new Error(`评测进程启动失败: ${err.message}`));
    });

    child.on('close', () => {
      try {
        resolvePromise(JSON.parse(stdout) as EvalReport);
      } catch {
        const detail = stderr.trim() || stdout.slice(0, ERROR_STDOUT_PREVIEW) || '(无输出)';
        reject(new Error(`评测输出无法解析为 JSON: ${detail}`));
      }
    });
  });
}

async function getReport(refresh: boolean): Promise<EvalReport> {
  if (!refresh && cache !== null && Date.now() - cache.ts < TTL_MS) {
    return cache.data;
  }
  if (inflight === null) {
    inflight = runEval()
      .then((data) => {
        cache = { ts: Date.now(), data };
        return data;
      })
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}

export async function evalRoutes(app: FastifyInstance): Promise<void> {
  app.get('/eval/report', async (req, reply) => {
    const query = req.query as { refresh?: string };
    const refresh = query.refresh === '1';
    try {
      return await getReport(refresh);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.status(500).send({ error: 'EVAL_SPAWN_FAILED', message });
    }
  });
}
