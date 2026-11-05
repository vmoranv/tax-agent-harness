#!/usr/bin/env node
/**
 * 覆盖率门禁：断言 REQ-01..18 与 INV-01..22 每条都至少有一个用例。
 *
 * 为什么单独一个脚本：文档里的追溯表会腐烂，这个话题不用人去数。
 * 补了新用例却漏了 requirement 标注、或者删了某条用例导致需求失守，
 * 这里会直接失败。
 */

import { l1DomainCases } from './cases/l1-domain.mjs';
import { l2Cases } from './cases/l2-application.mjs';
import { l3Cases } from './cases/l3-adapters.mjs';
import { l4Cases } from './cases/l4-runtime.mjs';
import { l5Cases } from './cases/l5-e2e.mjs';
import { l6Cases } from './cases/l6-realmodel.mjs';
import { l7Cases } from './cases/l7-architecture.mjs';

const ALL = [
  ...l1DomainCases,
  ...l2Cases,
  ...l3Cases,
  ...l4Cases,
  ...l5Cases,
  ...l6Cases,
  ...l7Cases,
];

const split = (raw) =>
  raw === undefined || raw === null || raw === ''
    ? []
    : String(raw)
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s !== '' && s !== 'ALL');

const reqCovered = new Map();
const invCovered = new Map();

for (const c of ALL) {
  for (const r of split(c.requirement)) {
    if (!reqCovered.has(r)) reqCovered.set(r, []);
    reqCovered.get(r).push(c.id);
  }
  for (const i of c.invariants ?? []) {
    if (!invCovered.has(i)) invCovered.set(i, []);
    invCovered.get(i).push(c.id);
  }
}

const missingReq = [];
for (let n = 1; n <= 18; n += 1) {
  const key = `REQ-${String(n).padStart(2, '0')}`;
  if (!reqCovered.has(key)) missingReq.push(key);
}

const missingInv = [];
for (let n = 1; n <= 22; n += 1) {
  const key = `INV-${String(n).padStart(2, '0')}`;
  if (!invCovered.has(key)) missingInv.push(key);
}

// 未知编号（拼写错误会造成"看起来覆盖了其实没有"）
const knownReq = new Set(
  Array.from({ length: 18 }, (_, i) => `REQ-${String(i + 1).padStart(2, '0')}`),
);
const knownInv = new Set(
  Array.from({ length: 22 }, (_, i) => `INV-${String(i + 1).padStart(2, '0')}`),
);
const unknownReq = [...reqCovered.keys()].filter((k) => !knownReq.has(k));
const unknownInv = [...invCovered.keys()].filter((k) => !knownInv.has(k));

// 用例 ID 唯一性
const idCount = new Map();
for (const c of ALL) idCount.set(c.id, (idCount.get(c.id) ?? 0) + 1);
const dupIds = [...idCount.entries()].filter(([, n]) => n > 1).map(([id]) => id);

const problems = [];
if (missingReq.length > 0) problems.push(`未覆盖的需求: ${missingReq.join(', ')}`);
if (missingInv.length > 0) problems.push(`未覆盖的不变量: ${missingInv.join(', ')}`);
if (unknownReq.length > 0) problems.push(`未知需求编号（疑似拼写错误）: ${unknownReq.join(', ')}`);
if (unknownInv.length > 0)
  problems.push(`未知不变量编号（疑似拼写错误）: ${unknownInv.join(', ')}`);
if (dupIds.length > 0) problems.push(`重复的用例 ID: ${dupIds.join(', ')}`);

const reqRate = ((18 - missingReq.length) / 18) * 100;
const invRate = ((22 - missingInv.length) / 22) * 100;

if (problems.length === 0) {
  process.stdout.write(
    `覆盖率门禁 ✅  需求 ${18 - missingReq.length}/18 (${reqRate.toFixed(0)}%)  不变量 ${22 - missingInv.length}/22 (${invRate.toFixed(0)}%)  用例总数 ${ALL.length}\n`,
  );
  process.exit(0);
}

process.stderr.write(`覆盖率门禁 ❌\n`);
for (const p of problems) process.stderr.write(`  - ${p}\n`);
process.stderr.write(
  `\n需求 ${18 - missingReq.length}/18 (${reqRate.toFixed(0)}%)  不变量 ${22 - missingInv.length}/22 (${invRate.toFixed(0)}%)\n`,
);
process.exit(1);
