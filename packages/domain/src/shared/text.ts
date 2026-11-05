/**
 * 文本空值判定。
 *
 * 放在 shared 而不是 ledger：发票聚合需要它来判断「用途是否为空」，
 * 而用途义务（`purpose-obligation`）也需要它。若放在 ledger 内部，
 * 两个模块会互相引用形成循环依赖。
 *
 * 语义：`null`、空串、全空白（含全角空格）都算空。
 */

const BLANK_RE = /^\s*$/u;

export function isBlankText(value: string | null | undefined): boolean {
  return value === null || value === undefined || BLANK_RE.test(value);
}
