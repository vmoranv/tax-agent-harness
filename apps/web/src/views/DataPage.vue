<template>
  <div class="pa-4 data-page">
    <!-- 头部 -->
    <div class="d-flex align-center justify-space-between mb-4 flex-wrap ga-2">
      <div>
        <h2 class="text-h6 font-weight-bold d-flex align-center ga-2">
          <v-icon size="24" color="primary">mdi-database-outline</v-icon>
          数据中台
        </h2>
        <div class="text-caption text-medium-emphasis mt-1">
          底层数据表浏览 · 概览 + 各表分页查询
        </div>
      </div>
      <div class="d-flex align-center ga-2">
        <span v-if="overview" class="text-caption text-disabled tabular-nums">
          生成于 {{ formatTime(overview.generatedAt) }}
        </span>
        <v-btn
          color="primary"
          variant="tonal"
          size="small"
          prepend-icon="mdi-refresh"
          :loading="overviewLoading"
          :disabled="overviewLoading"
          @click="refresh"
        >
          刷新
        </v-btn>
      </div>
    </div>

    <!-- 概览加载态 -->
    <v-card v-if="overviewLoading && !overview" variant="outlined" class="pa-6">
      <v-skeleton-loader type="article, table-row@2, table" />
    </v-card>

    <!-- 概览错误态 -->
    <v-alert
      v-else-if="overviewError !== null && !overview"
      type="error"
      variant="tonal"
      density="comfortable"
    >
      <div class="text-subtitle-2 mb-1">数据概览加载失败</div>
      <div class="text-caption">{{ overviewError }}</div>
      <template #append>
        <v-btn size="small" variant="text" prepend-icon="mdi-refresh" @click="loadOverview(false)">重试</v-btn>
      </template>
    </v-alert>

    <!-- 主体：容器页 + 嵌套 tab -->
    <template v-else-if="overview">
      <!--
        单一容器页 + 嵌套 tab：
        - tab 来自 fetchDataOverview().tables，另加固定「概览」tab
        - URL query ?tab= 等价于 AstrBot 的 meta.dataTab，驱动高亮（支持前进/后退）
        - localStorage('harness_data_last_tab') 记住上次 tab
      -->
      <v-tabs v-model="activeTab" color="primary" density="compact" class="mb-1">
        <v-tab v-for="t in tabs" :key="t.value" :value="t.value">
          <v-icon size="16" class="mr-1">{{ t.value === 'overview' ? 'mdi-view-dashboard-outline' : 'mdi-table' }}</v-icon>
          {{ t.label }}
        </v-tab>
      </v-tabs>
      <v-divider />

      <div class="pt-4">
        <!-- ─────────────── 概览 tab ─────────────── -->
        <template v-if="activeTab === 'overview'">
          <v-empty-state
            v-if="overview.tables.length === 0 && totalKeys.length === 0"
            icon="mdi-database-outline"
            title="暂无数据"
            text="后端概览返回为空：没有 totals，也没有可浏览的数据表"
            size="compact"
          />
          <template v-else>
            <!-- totals 卡片 -->
            <div class="text-subtitle-2 font-weight-bold mb-2 d-flex align-center ga-2">
              <v-icon size="18" color="primary">mdi-counter</v-icon>
              汇总指标（totals）
            </div>
            <v-row dense class="mb-4">
              <v-col v-for="(t, i) in totalCards" :key="t.key" cols="12" sm="6" md="4" lg="3">
                <v-card variant="outlined" class="pa-3 fill-height total-card" :style="{ '--total-accent': paletteColor(i) }">
                  <div class="text-caption text-medium-emphasis text-truncate" :title="t.key">{{ t.key }}</div>
                  <div class="text-h5 font-weight-bold mt-1 tabular-nums" :style="{ color: paletteColor(i) }">
                    {{ t.value.toLocaleString() }}
                  </div>
                </v-card>
              </v-col>
              <v-col v-if="totalCards.length === 0" cols="12">
                <div class="text-caption text-disabled">（无 totals 指标）</div>
              </v-col>
            </v-row>

            <!-- 表计数列表 -->
            <div class="text-subtitle-2 font-weight-bold mb-2 d-flex align-center ga-2">
              <v-icon size="18" color="primary">mdi-table-multiple</v-icon>
              数据表（{{ overview.tables.length }}）· 点击查看明细
            </div>
            <v-card variant="outlined" style="border-radius: var(--panel-border-radius)">
              <v-list density="compact">
                <v-list-item
                  v-for="t in overview.tables"
                  :key="t.name"
                  class="clickable-row"
                  @click="activeTab = t.name"
                >
                  <template #prepend>
                    <v-icon size="18" color="primary" class="mr-2">mdi-table</v-icon>
                  </template>
                  <v-list-item-title class="text-body-2">{{ t.label }}</v-list-item-title>
                  <v-list-item-subtitle class="tabular-nums text-caption">{{ t.name }}</v-list-item-subtitle>
                  <template #append>
                    <v-chip size="x-small" variant="tonal" color="primary" class="tabular-nums mr-2">
                      {{ t.count.toLocaleString() }} 行
                    </v-chip>
                    <v-icon size="16">mdi-chevron-right</v-icon>
                  </template>
                </v-list-item>
                <v-list-item v-if="overview.tables.length === 0">
                  <v-list-item-title class="text-caption text-disabled">没有可浏览的数据表</v-list-item-title>
                </v-list-item>
              </v-list>
            </v-card>
          </template>
        </template>

        <!-- ─────────────── 数据表 tab ─────────────── -->
        <template v-else>
          <div class="d-flex align-center justify-space-between mb-2 flex-wrap ga-2">
            <div class="text-subtitle-2 font-weight-bold d-flex align-center ga-2">
              <v-icon size="18" color="primary">mdi-table</v-icon>
              {{ currentTableLabel }}
              <span class="text-caption text-disabled tabular-nums font-weight-normal">({{ activeTab }})</span>
            </div>
            <div class="text-caption text-medium-emphasis tabular-nums">
              共 {{ total.toLocaleString() }} 行 · 每页 {{ pageSize }} 行
            </div>
          </div>

          <!-- 表加载态 -->
          <v-card v-if="tableLoading && tableResult === null" variant="outlined" class="pa-4">
            <v-skeleton-loader type="table-row@4, table" />
          </v-card>

          <!-- 表错误态 -->
          <v-alert
            v-else-if="tableError !== null"
            type="error"
            variant="tonal"
            density="comfortable"
          >
            <div class="text-subtitle-2 mb-1">数据表「{{ activeTab }}」加载失败</div>
            <div class="text-caption">{{ tableError }}</div>
            <template #append>
              <v-btn size="small" variant="text" prepend-icon="mdi-refresh" @click="loadTable">重试</v-btn>
            </template>
          </v-alert>

          <!-- 表数据 -->
          <v-card v-else variant="outlined" style="border-radius: var(--panel-border-radius)">
            <div class="table-scroll">
              <v-table density="compact" class="data-table">
                <thead>
                  <tr>
                    <th v-for="c in columns" :key="c" class="text-left text-no-wrap">{{ c }}</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="(row, ri) in (tableResult?.rows ?? [])" :key="ri">
                    <td
                      v-for="c in columns"
                      :key="c"
                      class="text-body-2 data-cell tabular-nums"
                      :title="cellText(row[c])"
                    >
                      {{ cellText(row[c]) }}
                    </td>
                  </tr>
                  <tr v-if="!tableResult || tableResult.rows.length === 0">
                    <td :colspan="Math.max(1, columns.length)" class="text-center text-caption text-disabled pa-6">
                      该表暂无数据
                    </td>
                  </tr>
                </tbody>
              </v-table>
            </div>

            <!-- 分页：上一页 / 下一页 offset -->
            <v-divider />
            <div class="d-flex align-center ga-2 pa-2 flex-wrap">
              <span class="text-caption text-medium-emphasis tabular-nums">
                {{ rangeStart }}–{{ rangeEnd }} / {{ total.toLocaleString() }}
              </span>
              <v-spacer />
              <v-btn
                size="small"
                variant="text"
                prepend-icon="mdi-chevron-left"
                :disabled="!canPrev || tableLoading"
                @click="prevPage"
              >
                上一页
              </v-btn>
              <span class="text-caption text-disabled tabular-nums">
                第 {{ currentPage }} / {{ totalPages }} 页
              </span>
              <v-btn
                size="small"
                variant="text"
                append-icon="mdi-chevron-right"
                :disabled="!canNext || tableLoading"
                @click="nextPage"
              >
                下一页
              </v-btn>
              <v-btn
                size="small"
                variant="text"
                icon="mdi-refresh"
                :loading="tableLoading"
                aria-label="重新加载当前页"
                @click="loadTable"
              />
            </div>
          </v-card>
        </template>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import {
  type DataOverview,
  type DataTableResult,
  fetchDataOverview,
  fetchDataTable,
} from '@/api/harness';

/* ------------------------------ 常量 ------------------------------ */

const STORAGE_KEY = 'harness_data_last_tab';
const pageSize = 100;
const OVERVIEW_TAB = 'overview';

const route = useRoute();
const router = useRouter();

/* ------------------------------ 概览状态 ------------------------------ */

const overview = ref<DataOverview | null>(null);
const overviewLoading = ref(false);
const overviewError = ref<string | null>(null);
const ready = ref(false);

/* ------------------------------ tab 状态 ------------------------------ */

const activeTab = ref<string>(OVERVIEW_TAB);

interface TabItem {
  value: string;
  label: string;
}

const tabs = computed<TabItem[]>(() => {
  const items: TabItem[] = [{ value: OVERVIEW_TAB, label: '概览' }];
  for (const t of overview.value?.tables ?? []) {
    items.push({ value: t.name, label: t.label || t.name });
  }
  return items;
});

function isValidTab(v: string): boolean {
  return v === OVERVIEW_TAB || (overview.value?.tables.some((t) => t.name === v) ?? false);
}

/**
 * 初始 tab 解析优先级：
 * 1) URL query ?tab=（等价 meta.dataTab，驱动高亮，支持前进/后退）
 * 2) localStorage('harness_data_last_tab')
 * 3) 概览
 */
function resolveInitialTab(): string {
  const fromUrl = typeof route.query.tab === 'string' ? route.query.tab : '';
  if (fromUrl && isValidTab(fromUrl)) return fromUrl;
  let stored = '';
  try {
    stored = localStorage.getItem(STORAGE_KEY) ?? '';
  } catch {
    /* localStorage 不可用时忽略 */
  }
  if (stored && isValidTab(stored)) return stored;
  return OVERVIEW_TAB;
}

const isTableTab = computed(() => activeTab.value !== OVERVIEW_TAB && isValidTab(activeTab.value));

const currentTableLabel = computed(
  () => overview.value?.tables.find((t) => t.name === activeTab.value)?.label ?? activeTab.value,
);

/* ------------------------------ 概览 totals ------------------------------ */

const totalKeys = computed(() => Object.keys(overview.value?.totals ?? {}));
const totalCards = computed(() =>
  Object.entries(overview.value?.totals ?? {}).map(([key, value]) => ({
    key,
    value: Number(value) || 0,
  })),
);

const palette = [
  'rgb(var(--v-theme-primary))',
  'rgb(var(--v-theme-info))',
  'rgb(var(--v-theme-success))',
  'rgb(var(--v-theme-warning))',
  'rgb(var(--v-theme-error))',
  'rgb(var(--v-theme-secondary))',
];
function paletteColor(i: number): string {
  return palette[i % palette.length];
}

/* ------------------------------ 数据表状态 ------------------------------ */

const tableResult = ref<DataTableResult | null>(null);
const tableLoading = ref(false);
const tableError = ref<string | null>(null);
const offset = ref(0);

const columns = computed<string[]>(() => tableResult.value?.columns ?? []);
const total = computed(() => tableResult.value?.total ?? 0);

const canPrev = computed(() => offset.value > 0);
const canNext = computed(() => offset.value + pageSize < total.value);
const rangeStart = computed(() => (total.value === 0 ? 0 : offset.value + 1));
const rangeEnd = computed(() => Math.min(offset.value + pageSize, total.value));
const currentPage = computed(() => Math.floor(offset.value / pageSize) + 1);
const totalPages = computed(() => Math.max(1, Math.ceil(total.value / pageSize)));

function cellText(v: unknown): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'object') {
    try {
      return JSON.stringify(v);
    } catch {
      return String(v);
    }
  }
  return String(v);
}

async function loadTable(): Promise<void> {
  const name = activeTab.value;
  if (name === OVERVIEW_TAB || !isValidTab(name)) return;
  tableLoading.value = true;
  tableError.value = null;
  try {
    tableResult.value = await fetchDataTable(name, { limit: pageSize, offset: offset.value });
  } catch (err) {
    tableError.value = err instanceof Error ? err.message : String(err);
    tableResult.value = null;
  } finally {
    tableLoading.value = false;
  }
}

function prevPage(): void {
  if (!canPrev.value) return;
  offset.value = Math.max(0, offset.value - pageSize);
  void loadTable();
}

function nextPage(): void {
  if (!canNext.value) return;
  offset.value += pageSize;
  void loadTable();
}

/* ------------------------------ 加载 / 刷新 ------------------------------ */

async function loadOverview(keepTab = false): Promise<void> {
  overviewLoading.value = true;
  overviewError.value = null;
  try {
    overview.value = await fetchDataOverview();
    const initial = keepTab && isValidTab(activeTab.value) ? activeTab.value : resolveInitialTab();
    ready.value = true;
    if (initial === activeTab.value) {
      // watch 不会触发（值未变化），需要手动确保当前表数据加载
      if (isTableTab.value) void loadTable();
    } else {
      // 触发 watch(activeTab)：持久化 + 同步 URL + 重置分页 + 加载表
      activeTab.value = initial;
    }
  } catch (err) {
    overviewError.value = err instanceof Error ? err.message : String(err);
  } finally {
    overviewLoading.value = false;
  }
}

function refresh(): void {
  void loadOverview(true);
}

/* ------------------------------ tab 变化：持久化 + URL 高亮 + 加载 ------------------------------ */

watch(activeTab, (val) => {
  if (!ready.value) return;
  try {
    localStorage.setItem(STORAGE_KEY, val);
  } catch {
    /* localStorage 不可用时忽略 */
  }
  // meta.dataTab 等价：用 URL query 驱动高亮（omit path 会保持当前路由）
  if (route.query.tab !== val) {
    void router.replace({ path: route.path, query: { ...route.query, tab: val } }).catch(() => {});
  }
  offset.value = 0;
  tableResult.value = null;
  tableError.value = null;
  if (val !== OVERVIEW_TAB) void loadTable();
});

// 浏览器前进/后退：URL query.tab 变化时同步高亮
watch(
  () => route.query.tab,
  (t) => {
    if (!ready.value) return;
    if (typeof t === 'string' && t !== activeTab.value && isValidTab(t)) {
      activeTab.value = t;
    }
  },
);

onMounted(() => void loadOverview(false));

/* ------------------------------ 工具 ------------------------------ */

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString('zh-CN', { hour12: false });
  } catch {
    return iso;
  }
}
</script>

<style scoped>
.data-page {
  --track-bg: rgba(var(--v-theme-on-surface), 0.08);
}

.total-card {
  border-radius: var(--panel-border-radius);
  border-left: 3px solid var(--total-accent);
}

.table-scroll {
  overflow-x: auto;
}
.data-table :deep(th) {
  font-size: 0.75rem;
  font-weight: 600;
  white-space: nowrap;
  background: rgba(var(--v-theme-on-surface), 0.02);
}
.data-cell {
  max-width: 320px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
