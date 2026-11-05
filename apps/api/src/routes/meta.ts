/** 元数据端点：用户、企业、规则库。 */
import type { FastifyInstance } from 'fastify';
import type { Runtime } from '../runtime-factory.js';

/** 任务卡查询未带身份参数时的默认用户 / 企业 ID（演示数据）。 */
const DEFAULT_USER_ID = 'U001';
const DEFAULT_ENTERPRISE_ID = 'C001';
/** 金额「分 → 元」换算基数，以及「分」的固定两位宽度。 */
const CENTS_PER_YUAN = 100n;
const FEN_WIDTH = 2;

export async function metaRoutes(app: FastifyInstance): Promise<void> {
  const rt = (): Runtime => (app as unknown as { runtime: Runtime }).runtime;

  app.get('/users', async () => {
    const db = rt().db;
    const grants = db
      .prepare('SELECT user_id, enterprise_id, access_level FROM grant')
      .all() as Array<Record<string, unknown>>;

    const users = db.prepare('SELECT id, display_name FROM app_user ORDER BY id').all() as Array<
      Record<string, unknown>
    >;

    return {
      users: users.map((u) => ({
        id: u['id'],
        display_name: u['display_name'],
        grants: grants
          .filter((g) => g['user_id'] === u['id'])
          .map((g) => ({ enterpriseId: g['enterprise_id'], level: g['access_level'] })),
      })),
    };
  });

  app.get('/enterprises', async () => {
    const rows = rt()
      .db.prepare('SELECT id, legal_name FROM enterprise ORDER BY id')
      .all() as Array<Record<string, unknown>>;
    return {
      enterprises: rows.map((r) => ({ id: r['id'], legal_name: r['legal_name'] })),
    };
  });

  app.get('/rules', async () => {
    const rows = rt()
      .db.prepare(
        `SELECT code, version, title, category, scope_kind, scope_ent,
                effective_from, status, body, obligation
           FROM rule_doc
          ORDER BY code, CAST(version AS REAL) DESC`,
      )
      .all() as Array<Record<string, unknown>>;

    return {
      rules: rows.map((r) => {
        const obligationRaw = r['obligation'] as string | null;
        let obligationSummary: string | null = null;
        if (obligationRaw && obligationRaw !== 'null') {
          try {
            const parsed = JSON.parse(obligationRaw) as { kind: string; thresholdCents?: string };
            obligationSummary =
              parsed.kind === 'purpose_required_all'
                ? '每张发票都必须填写用途，不设金额门槛'
                : `单张发票金额 ≥ ${fmtCents(parsed.thresholdCents ?? '0')} 元时必须填写用途（含等于）`;
          } catch {
            obligationSummary = null;
          }
        }
        return {
          code: r['code'],
          version: r['version'],
          title: r['title'],
          category: r['category'],
          scope: r['scope_kind'] === 'global' ? '通用' : `企业 ${String(r['scope_ent'] ?? '')}`,
          effective_from: r['effective_from'],
          status: r['status'],
          body: r['body'],
          obligation_summary: obligationSummary,
        };
      }),
    };
  });

  app.get('/task-card', async (req) => {
    const q = req.query as { userId?: string; enterpriseId?: string };
    const uid = q.userId ?? DEFAULT_USER_ID;
    const eid = q.enterpriseId ?? DEFAULT_ENTERPRISE_ID;
    const card = await rt().facade.getTaskCard({
      actor: uid as never,
      enterpriseId: eid as never,
    });
    return { taskCard: card };
  });
}

function fmtCents(cents: string): string {
  const n = BigInt(cents);
  const yuan = n / CENTS_PER_YUAN;
  const fen = (n % CENTS_PER_YUAN).toString().padStart(FEN_WIDTH, '0');
  return `${yuan.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${fen}`;
}
