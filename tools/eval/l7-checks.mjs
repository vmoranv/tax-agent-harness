/**
 * L7 架构门禁的真实执行器（P0-3 整改）。
 *
 * 此前 run-eval.mjs 对 l7 只判断 `existsSync('.dependency-cruiser.cjs')`，
 * 8 个用例全是文件存在性同义反复（假 PASS）。这里真正跑一次 depcruise，
 * 把违规按 rule.name 分组；每个 L7 用例断言「自己那条规则零违规」。
 * L7-DEP-06（跨包深层 import）无对应 depcruise 规则，改用真实的源码扫描。
 */

import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './lib.mjs';

const DEPCRUISE_BIN = join(ROOT, 'node_modules/dependency-cruiser/bin/dependency-cruiser.mjs');
const CONFIG = join(ROOT, '.dependency-cruiser.cjs');

/** 跑一次 depcruise（JSON 输出），返回 { ruleName: violations[] }。 */
function cruiseViolations() {
  const out = execFileSync(
    process.execPath,
    [DEPCRUISE_BIN, '--config', CONFIG, '--output-type', 'json', 'packages', 'apps'],
    { cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const parsed = JSON.parse(out);
  const byRule = new Map();
  for (const v of parsed.summary.violations ?? []) {
    const name = v.rule?.name ?? '(unknown)';
    if (!byRule.has(name)) byRule.set(name, []);
    byRule.get(name).push(v);
  }
  return { byRule };
}

// 递归列出各包 src 目录下的 .ts 源码。
function sourceFiles(dir, acc = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return acc;
  }
  for (const name of entries) {
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (name === 'dist' || name === 'node_modules') continue;
      sourceFiles(full, acc);
    } else if (name.endsWith('.ts') && !name.endsWith('.test.ts')) {
      acc.push(full);
    }
  }
  return acc;
}

/** 真实扫描：禁止 `@harness/xxx/src/...` 这类绕过公共出口的深层 import。 */
function deepImportViolations() {
  const roots = ['packages', 'apps'].map((d) => join(ROOT, d));
  const files = roots.flatMap((r) => sourceFiles(r));
  const re = /@harness\/[a-z-]+\/(src|dist)\//;
  const hits = [];
  for (const f of files) {
    const text = readFileSync(f, 'utf8');
    const m = text.match(new RegExp(re, 'g'));
    if (m) hits.push({ file: f, imports: m });
  }
  return hits;
}

let cache = null;
function getChecks() {
  if (cache === null) {
    cache = { ...cruiseViolations(), deepImports: deepImportViolations() };
  }
  return cache;
}

/**
 * 单个 L7 用例的真实判定。
 * `c.rule` 为 depcruise 规则名；`'deep-import'` 走源码扫描。
 * 返回 { failures: string[] }。
 */
export function checkL7(c) {
  const checks = getChecks();
  const failures = [];

  if (c.rule === 'deep-import') {
    for (const h of checks.deepImports) {
      failures.push(`跨包深层 import：${h.file} → ${h.imports.join(', ')}`);
    }
    return { failures };
  }

  if (!c.rule) {
    return { failures: ['L7 用例未声明 rule（无法映射到真实 depcruise 规则）'] };
  }

  const vs = checks.byRule.get(c.rule) ?? [];
  for (const v of vs) {
    failures.push(`${c.rule}: ${v.from} → ${v.to}`);
  }
  return { failures };
}
