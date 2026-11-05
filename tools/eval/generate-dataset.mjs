#!/usr/bin/env node
/**
 * 从 Excel 重建 `fixtures/eval/dataset.source.json`。
 *
 * 只在赛题材料更新时运行；日常测试直接用已提交的 JSON。
 * 依赖 xlsx 文件本身，不引入任何第三方解析库——用 Node 内置的
 * zip 能力（`node:zlib`）解 xlsx 太脆，这里直接调用 Python 的
 * `openpyxl` 无关的 XML 解析路径也不可行，故采用子进程 + python3。
 *
 * 若环境中没有 python3，脚本会提示手动方式，不静默失败。
 */

import { execFileSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './lib.mjs';

const XLSX = join(ROOT, 'fixtures/excel/02_示例数据.xlsx');
const OUT = join(ROOT, 'fixtures/eval/dataset.source.json');

if (!existsSync(XLSX)) {
  process.stderr.write(`找不到示例数据: ${XLSX}\n`);
  process.exit(1);
}

const PY = `
import zipfile, json, sys
from decimal import Decimal
import xml.etree.ElementTree as ET

NS = '{http://schemas.openxmlformats.org/spreadsheetml/2006/main}'
z = zipfile.ZipFile(sys.argv[1])

def load(name):
    root = ET.fromstring(z.read(f'xl/worksheets/{name}.xml'))
    out = []
    for row in root.iter(NS + 'row'):
        c = {}
        for cell in row.iter(NS + 'c'):
            col = ''.join(ch for ch in cell.get('r') if ch.isalpha())
            v = cell.find(NS + 'v')
            c[col] = v.text if v is not None else ''
        if c.get('A', '').startswith('C0'):
            out.append(c)
    return out

def cents(s):
    return int((Decimal(s) * 100).to_integral_value())

invoices, bank = [], []
for r in load('sheet3'):
    invoices.append({
        'enterpriseId': r['A'], 'invoiceNo': r['B'], 'issuedOn': r['C'][:10],
        'month': r['C'][:7], 'sellerName': r['D'], 'itemName': r['E'],
        'amountCents': cents(r['F']),
        'purpose': (r.get('G') or '').strip() or None,
        'remark': (r.get('H') or '').strip() or None,
    })
for r in load('sheet4'):
    bank.append({
        'enterpriseId': r['A'], 'txnNo': r['B'], 'tradedOn': r['C'][:10],
        'month': r['C'][:7],
        'direction': 'expense' if r['D'] == '支出' else 'income',
        'amountCents': cents(r['E']),
        'counterparty': r['F'],
        'remark': (r.get('G') or '').strip() or None,
    })

json.dump({'invoices': invoices, 'bank': bank}, sys.stdout, ensure_ascii=False, indent=2)
`;

let out;
try {
  out = execFileSync('python', ['-I', '-c', PY, XLSX], {
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  });
} catch (err) {
  process.stderr.write('无法调用 python 解析 Excel。\n');
  process.stderr.write(
    '请确认 python 在 PATH 中，或手动维护 fixtures/eval/dataset.source.json。\n',
  );
  process.stderr.write(`${err.message}\n`);
  process.exit(1);
}

const data = JSON.parse(out);
if (data.invoices.length !== 40 || data.bank.length !== 48) {
  process.stderr.write(
    `数据条数异常：invoices=${data.invoices.length}（应 40），bank=${data.bank.length}（应 48）\n`,
  );
  process.exit(1);
}

writeFileSync(OUT, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
process.stdout.write(
  `已写入 ${OUT}\n发票 ${data.invoices.length} 条，银行流水 ${data.bank.length} 条\n`,
);
