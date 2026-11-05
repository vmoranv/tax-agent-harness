<template>
  <div class="pa-4 eval-page">
    <!-- 头部 -->
    <div class="d-flex align-center justify-space-between mb-4 flex-wrap ga-2">
      <div>
        <h2 class="text-h6 font-weight-bold d-flex align-center ga-2">
          <v-icon size="24" color="primary">mdi-chart-box-outline</v-icon>
          评测中台
        </h2>
        <div class="text-caption text-medium-emphasis mt-1">
          评测报告静态快照 · 刷新按钮调用 /api/eval/report?refresh=1 重新采集
        </div>
      </div>
      <div class="d-flex align-center ga-2">
        <v-btn
          color="primary"
          variant="tonal"
          size="small"
          prepend-icon="mdi-refresh"
          :loading="loading"
          :disabled="loading"
          @click="load(true)"
        >
          刷新报告
        </v-btn>
      </div>
    </div>

    <!-- 加载态 -->
    <v-card v-if="loading && report === null" variant="outlined" class="pa-6">
      <v-skeleton-loader type="article, table-row@3, table" />
    </v-card>

    <!-- 错误态 -->
    <v-alert
      v-else-if="error !== null"
      type="error"
      variant="tonal"
      class="mb-3"
      density="comfortable"
    >
      <div class="text-subtitle-2 mb-1">评测报告加载失败</div>
      <div class="text-caption">{{ error }}</div>
      <template #append>
        <v-btn size="small" variant="text" prepend-icon="mdi-refresh" @click="load(true)">重试</v-btn>
      </template>
    </v-alert>

    <!-- 空态 -->
    <v-empty-state
      v-else-if="report === null || report.total === 0"
      icon="mdi-chart-box-outline"
      title="暂无评测数据"
      text="后端尚未生成评测报告，或报告内没有任何用例"
      size="compact"
    />

    <!-- 主体 -->
    <template v-else>
      <!-- 6 个指标卡 -->
      <v-row dense class="mb-2">
        <v-col v-for="m in metricCards" :key="m.label" cols="12" sm="6" md="4" lg="2">
          <v-card variant="outlined" class="metric-card pa-3 fill-height" :style="{ '--metric-accent': m.color }">
            <div class="text-caption text-medium-emphasis d-flex align-center ga-1">
              <v-icon :size="15">{{ m.icon }}</v-icon>
              {{ m.label }}
            </div>
            <div class="text-h5 font-weight-bold mt-1 tabular-nums metric-value">{{ m.value }}</div>
            <div class="text-caption text-disabled mt-1">{{ m.hint }}</div>
          </v-card>
        </v-col>
      </v-row>

      <!-- 基准自检 + disclaimer -->
      <v-alert
        :type="report.golden.ok ? 'success' : 'error'"
        variant="tonal"
        density="compact"
        class="mb-3 text-caption"
      >
        <span class="font-weight-medium">基准自检（golden）：</span>
        {{ report.golden.ok ? '通过' : '未通过' }}
        <template v-if="report.golden.problems.length">
          · {{ report.golden.problems.join('；') }}
        </template>
      </v-alert>
      <v-alert type="info" variant="tonal" density="compact" class="mb-4 text-caption">
        {{ report.disclaimer }}
      </v-alert>

      <v-row dense class="mb-2">
        <!-- 官方 5 维权重条 -->
        <v-col cols="12" md="6">
          <v-card variant="outlined" class="fill-height pa-4" style="border-radius: var(--panel-border-radius)">
            <div class="text-subtitle-2 font-weight-bold d-flex align-center ga-2 mb-1">
              <v-icon size="18" color="primary">mdi-trophy-outline</v-icon>
              赛题官方评分维度
            </div>
            <div class="text-caption text-medium-emphasis mb-4">官方权重分布（合计 100%）</div>
            <div v-for="(d, i) in report.officialDimensions" :key="d.key" class="mb-3">
              <div class="d-flex align-center justify-space-between text-body-2 mb-1">
                <span>{{ d.name }}</span>
                <span class="tabular-nums font-weight-bold" :style="{ color: officialColor(i) }">{{ officialWeightPercent(d.weight) }}%</span>
              </div>
              <div class="weight-track">
                <div
                  class="weight-fill"
                  :style="{ width: officialWeightPercent(d.weight) + '%', background: officialColor(i) }"
                />
              </div>
              <div class="text-caption text-disabled mt-1">{{ d.look }}</div>
            </div>
            <v-empty-state
              v-if="report.officialDimensions.length === 0"
              icon="mdi-trophy-outline"
              title="无官方维度"
              size="compact"
            />
          </v-card>
        </v-col>

        <!-- 内部 7 维水平进度条 -->
        <v-col cols="12" md="6">
          <v-card variant="outlined" class="fill-height pa-4" style="border-radius: var(--panel-border-radius)">
            <div class="d-flex align-center justify-space-between flex-wrap ga-1 mb-1">
              <div class="text-subtitle-2 font-weight-bold d-flex align-center ga-2">
                <v-icon size="18" color="primary">mdi-radar</v-icon>
                内部工程指标（雷达 / 水平进度）
              </div>
              <v-chip size="x-small" variant="outlined" color="warning">非赛题评分</v-chip>
            </div>
            <div class="text-caption text-medium-emphasis mb-4">
              内部工程指标 · 非赛题评分。条长 = 当前得分（相对目标 target）
            </div>
            <div v-for="(dim, key) in report.dimensions" :key="key" class="mb-3">
              <div class="d-flex align-center justify-space-between text-body-2 mb-1">
                <span class="text-truncate mr-2" :title="dim.desc">
                  {{ dim.name }}
                  <span class="text-disabled text-caption">({{ key }})</span>
                </span>
                <span class="tabular-nums font-weight-bold flex-shrink-0" :style="{ color: healthColor(dim.health) }">
                  {{ scoreLabel(dim.score) }} <span class="text-caption text-disabled">/ {{ scoreLabel(dim.target) }}</span>
                  <v-chip size="x-small" variant="text" :color="healthTone(dim.health)" class="ml-1">{{ dim.health }}</v-chip>
                </span>
              </div>
              <div class="weight-track">
                <div
                  class="weight-fill"
                  :style="{ width: dimPercent(dim) + '%', background: healthColor(dim.health) }"
                />
              </div>
              <div class="text-caption text-disabled mt-1 d-flex justify-space-between flex-wrap ga-1">
                <span>{{ dim.desc }}</span>
                <span class="tabular-nums">
                  标签 {{ dim.taggedCount }} · 用例 {{ dim.uniqueCases }} · PASS {{ dim.pass }} · FAIL {{ dim.fail }}
                </span>
              </div>
            </div>
            <v-empty-state
              v-if="dimensionCount === 0"
              icon="mdi-radar"
              title="无内部维度"
              size="compact"
            />
          </v-card>
        </v-col>
      </v-row>

      <!-- 规则检索效果（真实 IR 指标，确定性检索 / 非向量） -->
      <v-card variant="outlined" class="pa-4 mb-4" style="border-radius: var(--panel-border-radius)">
        <div class="d-flex align-center justify-space-between flex-wrap ga-1 mb-1">
          <div class="text-subtitle-2 font-weight-bold d-flex align-center ga-2">
            <v-icon size="18" color="primary">mdi-text-search</v-icon>
            规则检索效果（Retrieval · 确定性检索 / 非向量 IR）
          </div>
          <v-chip size="x-small" variant="outlined" color="info">被测：真实 selectApplicableRules</v-chip>
        </div>
        <div class="text-caption text-medium-emphasis mb-3">
          对真实规则选择器注入候选规则，按独立 gold 集合计算 TP/FP/FN；与「内部 7 维雷达」的 PASS 通过率不同，这是集合检索质量指标。
        </div>
        <template v-if="report.retrieval?.available && report.retrieval.macro">
          <div class="d-flex flex-wrap ga-2 mb-3">
            <v-chip v-for="m in retrievalCards" :key="m.label" variant="tonal" :color="m.color" size="small" class="font-weight-medium tabular-nums">
              {{ m.label }} {{ m.value }}
            </v-chip>
          </div>
          <v-table density="compact" class="text-caption">
            <thead>
              <tr>
                <th class="text-left">查询</th>
                <th class="text-left">gold（应检索）</th>
                <th class="text-left">retrieved（实检索）</th>
                <th class="text-center">P</th>
                <th class="text-center">R</th>
                <th class="text-center">F1</th>
                <th class="text-center">版本一致</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="q in report.retrieval.queries" :key="q.enterprise + q.month">
                <td class="tabular-nums font-weight-medium">{{ q.enterprise }}/{{ q.month }}</td>
                <td class="tabular-nums">{{ q.gold.join(', ') }}</td>
                <td class="tabular-nums">{{ q.retrieved.join(', ') }}</td>
                <td class="text-center tabular-nums">{{ (q.precision * 100).toFixed(0) }}%</td>
                <td class="text-center tabular-nums">{{ (q.recall * 100).toFixed(0) }}%</td>
                <td class="text-center tabular-nums">{{ (q.f1 * 100).toFixed(0) }}%</td>
                <td class="text-center">
                  <v-icon size="14" :color="q.versionExact ? 'success' : 'error'">
                    {{ q.versionExact ? 'mdi-check' : 'mdi-close' }}
                  </v-icon>
                </td>
              </tr>
            </tbody>
          </v-table>
          <div class="text-caption text-disabled mt-2 tabular-nums">
            {{ report.retrieval.macro.queryCount }} 查询 × {{ report.retrieval.macro.candidateCount }} 候选规则 ·
            micro TP={{ report.retrieval.macro.micro.tp }} FP={{ report.retrieval.macro.micro.fp }} FN={{ report.retrieval.macro.micro.fn }}
          </div>
        </template>
        <v-alert v-else type="warning" variant="tonal" density="compact" class="text-caption">
          检索指标未计算：{{ report.retrieval?.reason ?? '后端未提供' }}
        </v-alert>
      </v-card>

      <!-- L1-L7 分层条形 -->
      <v-card variant="outlined" class="pa-4 mb-4" style="border-radius: var(--panel-border-radius)">
        <div class="text-subtitle-2 font-weight-bold d-flex align-center ga-2 mb-1">
          <v-icon size="18" color="primary">mdi-layers-outline</v-icon>
          L1–L7 分层通过情况
        </div>
        <div class="text-caption text-medium-emphasis mb-4">每层的 PASS / 总数比例（绿色 = PASS，红色 = FAIL）</div>
        <div v-for="(l, name) in report.byLayer" :key="name" class="mb-2">
          <div class="d-flex align-center text-body-2 mb-1 ga-2">
            <span class="tabular-nums font-weight-medium layer-name">{{ name }}</span>
            <span class="text-caption text-disabled tabular-nums flex-grow-1">
              FAIL {{ l.fail }} · BLOCKED {{ l.blocked }} · PENDING {{ l.pending }} · UNVERIFIED {{ l.unverified }} · MANUAL {{ l.manual }}
            </span>
            <span class="tabular-nums font-weight-bold">{{ l.pass }} / {{ l.total }}</span>
          </div>
          <div class="weight-track layer-track">
            <div class="weight-fill layer-pass" :style="{ width: ratio(l.pass, l.total) + '%' }" />
            <div class="layer-fail" :style="{ width: ratio(l.fail, l.total) + '%' }" />
          </div>
        </div>
        <v-empty-state v-if="layerCount === 0" icon="mdi-layers-outline" title="无分层数据" size="compact" />
      </v-card>

      <!-- 用例结果表格 -->
      <v-card variant="outlined" style="border-radius: var(--panel-border-radius)">
        <div class="d-flex align-center ga-2 pa-3 flex-wrap">
          <v-text-field
            v-model="keyword"
            density="compact"
            variant="outlined"
            hide-details
            clearable
            prepend-inner-icon="mdi-magnify"
            placeholder="搜索 id / title"
            style="max-width: 280px; min-width: 180px"
          />
          <div class="d-flex align-center ga-1 flex-wrap">
            <v-chip
              v-for="s in statusFilters"
              :key="s.value"
              size="small"
              :variant="statusFilter === s.value ? 'tonal' : 'outlined'"
              :color="s.color"
              class="clickable-row"
              @click="statusFilter = s.value"
            >
              {{ s.label }} · {{ statusCount(s.value) }}
            </v-chip>
          </div>
          <v-spacer />
          <span class="text-caption text-medium-emphasis">共 {{ filteredResults.length }} / {{ report.results.length }} 条 · 点行展开 failures</span>
        </div>

        <v-table density="compact" class="result-table">
          <thead>
            <tr>
              <th class="text-left">层级</th>
              <th class="text-left">编号</th>
              <th class="text-left">标题</th>
              <th class="text-left">状态</th>
              <th class="text-left">维度</th>
              <th class="text-center" style="width: 48px">展开</th>
            </tr>
          </thead>
          <tbody>
            <template v-for="r in filteredResults" :key="r.layer + '-' + r.id">
              <tr class="clickable-row" @click="toggleRow(r)">
                <td class="text-body-2 tabular-nums">{{ r.layer }}</td>
                <td class="text-body-2 tabular-nums">{{ r.id }}</td>
                <td class="text-body-2">{{ r.title }}</td>
                <td class="text-body-2">
                  <v-chip size="x-small" :color="statusColor(r.status)" variant="tonal">{{ r.status }}</v-chip>
                </td>
                <td class="text-caption text-medium-emphasis">
                  <span v-if="r.dimensions.length">{{ r.dimensions.join(', ') }}</span>
                  <span v-else class="text-disabled">—</span>
                </td>
                <td class="text-center">
                  <v-icon size="16" :icon="expandedKey === rowKey(r) ? 'mdi-chevron-up' : 'mdi-chevron-down'" />
                </td>
              </tr>
              <tr v-if="expandedKey === rowKey(r)" class="expanded-row">
                <td colspan="6" class="pa-3">
                  <div class="text-caption font-weight-medium mb-1">Failures / 失败原因</div>
                  <ul v-if="r.failures.length" class="ml-4 text-body-2">
                    <li v-for="(f, i) in r.failures" :key="i">{{ f }}</li>
                  </ul>
                  <div v-else class="text-caption text-disabled">无 failures（PASS / 未记录失败原因）</div>
                </td>
              </tr>
            </template>
            <tr v-if="filteredResults.length === 0">
              <td colspan="6" class="text-center text-caption text-disabled pa-6">没有匹配的用例</td>
            </tr>
          </tbody>
        </v-table>
      </v-card>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import {
  type EvalCaseResult,
  type EvalDimension,
  type EvalReport,
  fetchEvalReport,
} from '@/api/harness';

/* ------------------------------ 状态 ------------------------------ */

const loading = ref(false);
const error = ref<string | null>(null);
const report = ref<EvalReport | null>(null);

const keyword = ref('');
const statusFilter = ref('all');
const expandedKey = ref<string | null>(null);

const statusFilters = [
  { value: 'all', label: '全部', color: 'primary' },
  { value: 'pass', label: 'PASS', color: 'success' },
  { value: 'fail', label: 'FAIL', color: 'error' },
  { value: 'blocked', label: 'BLOCKED', color: 'warning' },
  { value: 'pending', label: 'PENDING', color: 'grey' },
  { value: 'unverified', label: 'UNVERIFIED', color: 'info' },
  { value: 'manual', label: 'MANUAL', color: 'secondary' },
];

/* ------------------------------ 数据加载 ------------------------------ */

async function load(refresh = false): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    report.value = await fetchEvalReport(refresh);
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
    report.value = null;
  } finally {
    loading.value = false;
  }
}

onMounted(() => void load(false));

/* ------------------------------ 指标卡 ------------------------------ */

/** byStatus 实际来自评测引擎，键为大写（PASS/FAIL/...）；这里做大小写不敏感读取，兼容两种来源。 */
function byStatusVal(k: string): number {
  const s = report.value?.byStatus;
  if (!s) return 0;
  const direct = s[k];
  if (typeof direct === 'number') return direct;
  const upper = s[k.toUpperCase()];
  if (typeof upper === 'number') return upper;
  const found = Object.entries(s).find(([key]) => key.toLowerCase() === k.toLowerCase());
  return found ? Number(found[1]) || 0 : 0;
}

const officialCount = computed(() => report.value?.officialDimensions?.length ?? 0);
const dimensionCount = computed(() => Object.keys(report.value?.dimensions ?? {}).length);
const layerCount = computed(() => Object.keys(report.value?.byLayer ?? {}).length);

const coverage = computed(() => {
  const r = report.value;
  if (!r || r.total === 0) return 0;
  const done = r.total - byStatusVal('pending') - byStatusVal('unverified');
  return Math.round((Math.max(0, done) / r.total) * 100);
});

const metricCards = computed(() => {
  const r = report.value;
  if (!r) return [];
  return [
    {
      label: '总用例',
      value: r.total,
      hint: '全部评测用例',
      icon: 'mdi-format-list-bulleted',
      color: 'rgb(var(--v-theme-primary))',
    },
    {
      label: 'PASS',
      value: byStatusVal('pass'),
      hint: '通过用例数',
      icon: 'mdi-check-circle-outline',
      color: 'rgb(var(--v-theme-success))',
    },
    {
      label: 'FAIL / MANUAL',
      value: `${byStatusVal('fail')} / ${byStatusVal('manual')}`,
      hint: '失败 / 人工复核',
      icon: 'mdi-alert-circle-outline',
      color: 'rgb(var(--v-theme-error))',
    },
    {
      label: '覆盖率',
      value: `${coverage.value}%`,
      hint: '非 pending / unverified 占比',
      icon: 'mdi-percent-outline',
      color: 'rgb(var(--v-theme-info))',
    },
    {
      label: '官方维度数',
      value: officialCount.value,
      hint: '赛题评分维度',
      icon: 'mdi-trophy-outline',
      color: 'rgb(var(--v-theme-warning))',
    },
    {
      label: '内部维度数',
      value: dimensionCount.value,
      hint: '工程指标 · 非赛题评分',
      icon: 'mdi-radar',
      color: 'rgb(var(--v-theme-secondary))',
    },
  ];
});

/** 检索效果 4 个指标 chip（确定性检索 IR 指标）。 */
const retrievalCards = computed(() => {
  const m = report.value?.retrieval?.macro;
  if (!m) return [];
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  return [
    { label: 'Precision', value: pct(m.precision), color: 'primary' },
    { label: 'Recall', value: pct(m.recall), color: 'info' },
    { label: 'F1', value: pct(m.f1), color: 'success' },
    { label: '版本命中率', value: pct(m.versionHitRate), color: 'warning' },
  ];
});

/* ------------------------------ 颜色 / 进度 ------------------------------ */

// 仅用主题变量映射的颜色，不硬编码深色底
const palette = [
  'rgb(var(--v-theme-primary))',
  'rgb(var(--v-theme-info))',
  'rgb(var(--v-theme-success))',
  'rgb(var(--v-theme-warning))',
  'rgb(var(--v-theme-error))',
  'rgb(var(--v-theme-secondary))',
];

/**
 * 官方权重：评测引擎返回的是小数（0.4 / 0.25 / 0.15 / 0.1 / 0.1），
 * 但契约/其它来源可能给 0-100。统一折算成「百分比数值」用于展示与条宽。
 */
function officialWeightPercent(weight: number): number {
  if (weight <= 1) return Math.round(weight * 100);
  return Math.round(weight);
}

function officialColor(i: number): string {
  return palette[i % palette.length];
}

/** 评测引擎 health 取值：EXCELLENT / DEGRADED / FAIL / N/A（兼容其它来源的常见同义词）。 */
function healthTone(health: string): string {
  switch (health.toUpperCase()) {
    case 'EXCELLENT':
    case 'GOOD':
    case 'OK':
    case 'HEALTHY':
    case 'PASS':
      return 'success';
    case 'DEGRADED':
    case 'WARN':
    case 'WARNING':
    case 'MEDIUM':
      return 'warning';
    case 'FAIL':
    case 'BAD':
    case 'CRITICAL':
      return 'error';
    default:
      return 'grey';
  }
}

/** 条色/数字色用主题 rgb 变量（与 healthTone 保持一致）。 */
function healthColor(health: string): string {
  const map: Record<string, string> = {
    success: 'rgb(var(--v-theme-success))',
    warning: 'rgb(var(--v-theme-warning))',
    error: 'rgb(var(--v-theme-error))',
    grey: 'rgb(var(--v-theme-primary))',
  };
  return map[healthTone(health)] ?? 'rgb(var(--v-theme-primary))';
}

/** score/target 在评测引擎里是 0-1 小数，统一显示为百分比；已是 0-100 的值原样显示。 */
function scoreLabel(v: number | null): string {
  if (v === null) return '—';
  const pct = v <= 1 ? Math.round(v * 100) : Math.round(v);
  return pct + '%';
}

/** 条长 = score 相对 target 的完成度（score/target），封顶 100%。 */
function dimPercent(dim: EvalDimension): number {
  if (dim.score === null || dim.target <= 0) return 0;
  return Math.min(100, Math.max(0, Math.round((dim.score / dim.target) * 100)));
}

function statusColor(status: string): string {
  const s = status.toLowerCase();
  if (s.includes('pass') || s.includes('ok')) return 'success';
  if (s.includes('fail') || s.includes('error')) return 'error';
  if (s.includes('block')) return 'warning';
  if (s.includes('manual')) return 'secondary';
  if (s.includes('unverified')) return 'info';
  return 'grey';
}

function ratio(part: number, total: number): number {
  if (total <= 0) return 0;
  return Math.min(100, Math.max(0, Math.round((part / total) * 100)));
}

/* ------------------------------ 表格过滤 / 展开 ------------------------------ */

function rowKey(r: EvalCaseResult): string {
  return `${r.layer}-${r.id}`;
}

function matchStatus(r: EvalCaseResult): boolean {
  if (statusFilter.value === 'all') return true;
  return r.status.toLowerCase().includes(statusFilter.value);
}

const filteredResults = computed(() => {
  const r = report.value;
  if (!r) return [];
  const kw = keyword.value.trim().toLowerCase();
  return r.results.filter((item) => {
    if (!matchStatus(item)) return false;
    if (!kw) return true;
    return item.id.toLowerCase().includes(kw) || item.title.toLowerCase().includes(kw);
  });
});

function statusCount(value: string): number {
  const r = report.value;
  if (!r) return 0;
  if (value === 'all') return r.results.length;
  return r.results.filter((item) => item.status.toLowerCase().includes(value)).length;
}

function toggleRow(r: EvalCaseResult): void {
  const k = rowKey(r);
  expandedKey.value = expandedKey.value === k ? null : k;
}
</script>

<style scoped>
.eval-page {
  --track-bg: rgba(var(--v-theme-on-surface), 0.08);
}

.metric-card {
  border-radius: var(--panel-border-radius);
  border-left: 3px solid var(--metric-accent);
}
.metric-value {
  color: var(--metric-accent);
}

.weight-track {
  position: relative;
  width: 100%;
  height: 8px;
  border-radius: 999px;
  background: var(--track-bg);
  overflow: hidden;
  display: flex;
}
.weight-fill {
  height: 100%;
  border-radius: 999px;
  transition: width var(--dur-normal) var(--ease-spring);
  flex-shrink: 0;
}

.layer-track {
  height: 10px;
}
.layer-pass {
  background: rgb(var(--v-theme-success));
}
.layer-fail {
  height: 100%;
  background: rgb(var(--v-theme-error));
  opacity: 0.7;
  flex-shrink: 0;
}
.layer-name {
  width: 48px;
  flex-shrink: 0;
}

.result-table :deep(th) {
  font-size: 0.75rem;
  white-space: nowrap;
}
.expanded-row {
  background: rgba(var(--v-theme-on-surface), 0.03);
}
</style>
