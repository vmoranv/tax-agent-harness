<template>
  <div class="console-root pa-4 d-flex flex-column fill-height" style="height: 100%; gap: 12px">
    <!-- ─────────────── 顶部工具栏 ─────────────── -->
    <v-card variant="outlined" class="flex-shrink-0" style="border-radius: var(--panel-border-radius)">
      <div class="px-4 py-2 d-flex align-center ga-2 flex-wrap">
        <v-icon size="18" class="text-medium-emphasis">mdi-console-line</v-icon>
        <span class="text-body-2 font-weight-medium mr-1">实时日志控制台</span>

        <v-chip size="x-small" :color="statusColor" variant="tonal" class="font-weight-medium">
          <v-icon size="12" class="mr-1">mdi-broadcast</v-icon>
          {{ statusText }}
        </v-chip>
        <v-chip v-if="paused && pausedNew > 0" size="x-small" color="warning" variant="tonal" class="tabular-nums">
          已暂停 · {{ pausedNew }} 条新日志
        </v-chip>

        <v-spacer />

        <!-- 关键词（250ms 防抖） -->
        <v-text-field
          v-model="keyword"
          density="compact"
          variant="outlined"
          hide-details
          placeholder="搜索日志 / runId / 工具名"
          prepend-inner-icon="mdi-magnify"
          clearable
          style="min-width: 200px; max-width: 320px"
        />

        <!-- 字号记忆 -->
        <div class="d-flex align-center flex-shrink-0 font-ctl">
          <v-btn size="x-small" variant="text" icon="mdi-minus" @click="changeFontSize(-1)" />
          <span class="tabular-nums text-caption text-medium-emphasis" style="min-width: 26px; text-align: center">{{ fontSize }}</span>
          <v-btn size="x-small" variant="text" icon="mdi-plus" @click="changeFontSize(1)" />
        </div>

        <v-btn size="small" variant="tonal" :color="paused ? 'warning' : 'default'"
               :prepend-icon="paused ? 'mdi-play' : 'mdi-pause'" @click="paused = !paused">
          {{ paused ? '继续' : '暂停' }}
        </v-btn>
        <v-btn size="small" variant="text" prepend-icon="mdi-delete-outline" @click="clearLogs">清空</v-btn>
        <v-btn size="small" variant="text" prepend-icon="mdi-download" @click="exportDialog = true">导出</v-btn>
        <v-btn size="small" variant="text" :icon="isFullscreen ? 'mdi-fullscreen-exit' : 'mdi-fullscreen'" @click="toggleFullscreen" />
        <v-btn v-if="connectFailed" size="small" variant="tonal" color="error" prepend-icon="mdi-refresh" @click="manualReconnect">重连</v-btn>
      </div>

      <!-- 加载进度条 -->
      <v-progress-linear v-if="loading" indeterminate height="2" :color="'primary'" />
    </v-card>

    <!-- ─────────────── 主体：左筛选 / 右终端 ─────────────── -->
    <div class="console-body d-flex flex-fill" style="gap: 12px; min-height: 0">
      <!-- 左侧筛选面板 -->
      <v-card variant="outlined" class="filter-panel flex-shrink-0" style="border-radius: var(--panel-border-radius)">
        <div class="pa-3 d-flex flex-column ga-4" style="height: 100%; overflow-y: auto">
          <div>
            <div class="panel-title">等级筛选</div>
            <button
              v-for="lv in levels"
              :key="lv.key"
              type="button"
              class="level-item"
              @click="toggleLevel(lv.key)"
            >
              <span class="level-dot" :class="`dot-${lv.key}`" />
              <v-icon
                :icon="selectedLevels.includes(lv.key) ? 'mdi-checkbox-marked' : 'mdi-checkbox-blank-outline'"
                size="16"
              />
              <span class="level-label">{{ lv.label }}</span>
              <span class="level-count tabular-nums">{{ levelCounts[lv.key] }}</span>
            </button>
          </div>

          <div>
            <div class="panel-title">runId</div>
            <v-select
              v-model="runFilter"
              :items="runIdItems"
              item-title="title"
              item-value="value"
              density="compact"
              variant="outlined"
              hide-details
            />
          </div>

          <div>
            <div class="panel-title">显示选项</div>
            <v-switch v-model="hideUser" density="compact" hide-details color="primary" label="隐藏 user 消息" />
          </div>

          <v-divider />

          <!-- 统计条：各等级计数 -->
          <div>
            <div class="panel-title">统计</div>
            <div class="stat-line">
              <span>共 <b class="tabular-nums">{{ logs.length }}</b> 条</span>
              <span class="text-medium-emphasis">显示 <b class="tabular-nums">{{ filtered.length }}</b> 条</span>
            </div>
            <div v-for="lv in levels" :key="lv.key" class="stat-line">
              <span class="d-flex align-center ga-2">
                <span class="level-dot" :class="`dot-${lv.key}`" />
                {{ lv.label }}
              </span>
              <b class="tabular-nums">{{ levelCounts[lv.key] }}</b>
            </div>
          </div>

          <v-spacer />
          <div class="text-caption text-medium-emphasis" style="line-height: 1.4">
            环形缓存上限 1000 条 · 按 time+level+msg 去重；筛选项从缓存动态推导。
          </div>
        </div>
      </v-card>

      <!-- 右侧终端式日志区 -->
      <div ref="terminalRef" class="terminal-wrap flex-fill">
        <div class="terminal d-flex flex-column fill-height">
          <div class="terminal-scroll flex-fill" ref="logPanel" :style="{ fontSize: fontSize + 'px' }" @scroll="onScroll">
            <!-- 加载态 -->
            <div v-if="loading && logs.length === 0" class="terminal-hint">加载历史日志…</div>

            <!-- 错误态 -->
            <div v-else-if="loadError && logs.length === 0" class="terminal-hint terminal-error">
              <v-icon icon="mdi-alert-circle-outline" size="20" class="mb-1" />
              <div>加载历史日志失败：{{ loadError }}</div>
              <v-btn size="x-small" variant="tonal" class="mt-2" prepend-icon="mdi-refresh" @click="loadHistory">重试</v-btn>
            </div>

            <!-- 空态 -->
            <v-empty-state
              v-else-if="filtered.length === 0"
              icon="mdi-console-line"
              title="暂无日志"
              text="触发一次对话或验证场景后，运行日志会实时出现在这里；也可调整左侧筛选条件"
            />

            <!-- 日志行：时间 / 等级 / 消息 三段 -->
            <template v-else>
              <div
                v-for="e in filtered"
                :key="entryKey(e)"
                class="log-row"
                :class="`row-${e.level}`"
              >
                <span class="seg-time tabular-nums">{{ formatTime(e.time) }}</span>
                <span class="seg-level" :class="`lvl-${e.level}`">{{ e.level.toUpperCase() }}</span>
                <span class="seg-msg">
                  <span v-if="e.context?.runId" class="run-tag tabular-nums">[{{ e.context.runId }}]</span>
                  <template v-for="(seg, si) in highlight(e.msg)" :key="si">
                    <span v-if="seg.hit" class="hl">{{ seg.text }}</span>
                    <template v-else>{{ seg.text }}</template>
                  </template>
                  <span v-if="metaText(e)" class="meta-tag tabular-nums" :title="metaText(e)">{{ metaText(e) }}</span>
                </span>
              </div>
            </template>
          </div>

          <!-- 回到最新 -->
          <v-btn
            v-if="!atBottom && filtered.length > 0"
            class="jump-latest"
            size="x-small"
            variant="tonal"
            color="primary"
            prepend-icon="mdi-arrow-down"
            @click="stickNow"
          >回到最新</v-btn>
        </div>
      </div>
    </div>

    <!-- ─────────────── 导出对话框 ─────────────── -->
    <v-dialog v-model="exportDialog" max-width="440">
      <v-card style="border-radius: var(--panel-border-radius)">
        <v-card-title class="text-body-1 font-weight-medium d-flex align-center ga-2">
          <v-icon icon="mdi-download" size="18" />导出日志
        </v-card-title>
        <v-card-text class="d-flex flex-column ga-4">
          <v-select
            v-model="exportRange"
            :items="exportRanges"
            item-title="title"
            item-value="value"
            label="时间范围"
            density="compact"
            variant="outlined"
            hide-details
          />
          <v-switch v-model="exportRedact" density="compact" hide-details color="primary"
                    label="脱敏（替换 sk- / apiKey / token / Bearer 等密钥）" />
          <div class="text-caption text-medium-emphasis">
            将当前缓存中符合范围的日志导出为纯文本 .log 文件（共 {{ logs.length }} 条缓存）。
          </div>
        </v-card-text>
        <v-card-actions class="px-4 pb-4">
          <v-spacer />
          <v-btn size="small" variant="text" @click="exportDialog = false">取消</v-btn>
          <v-btn size="small" variant="tonal" color="primary" prepend-icon="mdi-content-save" @click="doExport">导出 .log</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { fetchRecentLogs, type LogEntryDto, streamLogs } from '@/api/harness';
import { useToastStore } from '@/stores/toast';

/* ------------------------------ 常量 ------------------------------ */

const MAX_CACHE = 1000;
const MAX_RETRY = 10;
const RETRY_BASE_MS = 1000;
const RETRY_CAP_MS = 30000;
const DEBOUNCE_MS = 250;
const STICK_THRESHOLD_PX = 24;
const FONT_KEY = 'harness_console_font_size';

type LogLevel = LogEntryDto['level'];

const levels: Array<{ key: LogLevel; label: string }> = [
  { key: 'debug', label: 'DEBUG' },
  { key: 'info', label: 'INFO' },
  { key: 'warn', label: 'WARN' },
  { key: 'error', label: 'ERROR' },
];

const toast = useToastStore();

function notify(message: string, color = 'error'): void {
  toast.add({ message, color, timeout: 3000 });
}

/* ------------------------------ 数据 / 环形缓存 ------------------------------ */

const logs = ref<LogEntryDto[]>([]);
const seen = new Set<string>();

/** 去重键：time + level + msg（按需求，不含 runId）。 */
function entryKey(e: LogEntryDto): string {
  return `${e.time}\u0000${e.level}\u0000${e.msg}`;
}

/** 入环形缓存；重复返回 false。淘汰队首时同步清理 seen，避免无界增长。 */
function append(e: LogEntryDto): boolean {
  const k = entryKey(e);
  if (seen.has(k)) return false;
  seen.add(k);
  logs.value.push(e);
  if (logs.value.length > MAX_CACHE) {
    const removed = logs.value.splice(0, logs.value.length - MAX_CACHE);
    for (const r of removed) seen.delete(entryKey(r));
  }
  return true;
}

/* ------------------------------ 连接状态 / SSE 重连 ------------------------------ */

const connected = ref(false);
const reconnecting = ref(false);
const connectFailed = ref(false);

let closeStream: (() => void) | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let retry = 0;
let isUnmounted = false;

function connect(): void {
  if (isUnmounted) return;
  closeStream?.();
  closeStream = streamLogs(
    (e) => {
      void push(e);
    },
    {
      onOpen: () => {
        retry = 0; // 连接恢复，退避计数清零
        connected.value = true;
        reconnecting.value = false;
        connectFailed.value = false;
      },
      onError: () => {
        connected.value = false;
        closeStream?.();
        closeStream = null;
        scheduleReconnect();
      },
    },
  );
}

/** SSE onerror → 指数退避重连：min(1000 * 2^n, 30000)，最多 10 次。 */
function scheduleReconnect(): void {
  if (isUnmounted || reconnectTimer !== null) return;
  if (retry >= MAX_RETRY) {
    reconnecting.value = false;
    connectFailed.value = true;
    notify('日志实时连接失败，已达最大重试次数，可点击「重连」', 'error');
    return;
  }
  const delay = Math.min(RETRY_BASE_MS * 2 ** retry, RETRY_CAP_MS);
  retry += 1;
  reconnecting.value = true;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
}

function manualReconnect(): void {
  retry = 0;
  connectFailed.value = false;
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  connect();
}

const statusText = computed(() => {
  if (connected.value) return '实时连接';
  if (connectFailed.value) return '已断开';
  if (reconnecting.value) return '重连中';
  return '连接中';
});
const statusColor = computed(() => {
  if (connected.value) return 'success';
  if (connectFailed.value) return 'error';
  return 'warning';
});

/* ------------------------------ 加载 / 错误 / 空态 ------------------------------ */

const loading = ref(true);
const loadError = ref<string | null>(null);

async function loadHistory(): Promise<void> {
  loading.value = true;
  loadError.value = null;
  try {
    const recent = await fetchRecentLogs(200);
    if (isUnmounted) return;
    for (const e of recent) append(e);
    await nextTick();
    stickNow();
  } catch (err) {
    loadError.value = err instanceof Error ? err.message : String(err);
    notify('加载历史日志失败：' + loadError.value, 'error');
  } finally {
    loading.value = false;
  }
}

/* ------------------------------ 筛选 ------------------------------ */

const selectedLevels = ref<LogLevel[]>(['debug', 'info', 'warn', 'error']);
const runFilter = ref<string>('all');
const hideUser = ref(false);
const keyword = ref('');
const debouncedKeyword = ref('');

let debounceTimer: ReturnType<typeof setTimeout> | null = null;
watch(keyword, (v) => {
  if (debounceTimer !== null) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debouncedKeyword.value = v;
  }, DEBOUNCE_MS);
});

function toggleLevel(k: LogLevel): void {
  const i = selectedLevels.value.indexOf(k);
  if (i >= 0) selectedLevels.value.splice(i, 1);
  else selectedLevels.value.push(k);
}

/** runId 下拉项：从缓存动态推导，不请求后端。 */
const runIdItems = computed(() => {
  const s = new Set<string>();
  for (const e of logs.value) {
    const id = e.context?.runId;
    if (id) s.add(id);
  }
  return [
    { title: '全部', value: 'all' },
    ...[...s].sort().map((id) => ({ title: id, value: id })),
  ];
});

const levelCounts = computed<Record<LogLevel, number>>(() => {
  const c: Record<LogLevel, number> = { debug: 0, info: 0, warn: 0, error: 0 };
  for (const e of logs.value) c[e.level] = (c[e.level] ?? 0) + 1;
  return c;
});

/** 结构化字段合并（e.fields 优先于 context.fields）。 */
function allFields(e: LogEntryDto): Record<string, unknown> {
  return { ...(e.context?.fields ?? {}), ...(e.fields ?? {}) };
}

/**
 * 是否为「user 消息」。
 * 后端 LogEntryDto 无 role 字段，因此基于常见结构化标记做启发式判断：
 * role/source/direction/kind/type 等为 user|in|input 或显式布尔标记，或 msg 含用户消息前缀。
 * 当前 runtime 未 emit 这类字段时该开关为空操作，但字段一旦出现即生效。
 */
function isUserMessage(e: LogEntryDto): boolean {
  const f = allFields(e);
  const markers = ['role', 'source', 'from', 'direction', 'kind', 'type', 'channel', 'origin'];
  for (const k of markers) {
    const v = f[k];
    if (typeof v === 'string' && /^(user|in|input|incoming|human)$/i.test(v.trim())) return true;
  }
  const tagged = f.isUserMessage ?? f.userMessage ?? f.fromUser;
  if (tagged === true || tagged === 'true') return true;
  const msg = e.msg.toLowerCase();
  return ['[user]', '用户输入', '用户消息', 'user message'].some((m) => msg.includes(m));
}

function metaText(e: LogEntryDto): string {
  const fields = allFields(e);
  const parts: string[] = [];
  for (const [k, v] of Object.entries(fields)) {
    if (k === 'tool' || k === 'name' || k === 'ok' || k === 'elapsedMs') {
      parts.push(`${k}=${String(v)}`);
    }
  }
  if (e.error !== undefined) parts.push(`err=${e.error.message}`);
  return parts.join(' ');
}

const filtered = computed(() => {
  const kw = debouncedKeyword.value.trim().toLowerCase();
  const lv = new Set<LogLevel>(selectedLevels.value);
  const run = runFilter.value;
  return logs.value.filter((e) => {
    if (!lv.has(e.level)) return false;
    if (run !== 'all' && e.context?.runId !== run) return false;
    if (hideUser.value && isUserMessage(e)) return false;
    if (kw !== '') {
      const hay =
        `${e.msg} ${e.context?.runId ?? ''} ${e.context?.userId ?? ''} ${metaText(e)}`.toLowerCase();
      if (!hay.includes(kw)) return false;
    }
    return true;
  });
});

/** 命中高亮：大小写不敏感、无正则转义问题、保留原文大小写。 */
interface Segment {
  text: string;
  hit: boolean;
}
function highlight(text: string): Segment[] {
  const kw = debouncedKeyword.value.trim().toLowerCase();
  if (kw === '') return [{ text, hit: false }];
  const lower = text.toLowerCase();
  const out: Segment[] = [];
  let i = 0;
  for (;;) {
    const idx = lower.indexOf(kw, i);
    if (idx === -1) {
      if (i < text.length) out.push({ text: text.slice(i), hit: false });
      break;
    }
    if (idx > i) out.push({ text: text.slice(i, idx), hit: false });
    out.push({ text: text.slice(idx, idx + kw.length), hit: true });
    i = idx + kw.length;
  }
  return out;
}

/* ------------------------------ 滚动 / 暂停 / 清空 ------------------------------ */

const logPanel = ref<HTMLElement | null>(null);
const atBottom = ref(true);
const paused = ref(false);
const pausedNew = ref(0);

/** 暂停期间收到的日志：冻结展示用 logs，不丢缓存，恢复时一次性 flush。 */
let pending: LogEntryDto[] = [];

function nearBottom(): boolean {
  const el = logPanel.value;
  if (!el) return true;
  return el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_THRESHOLD_PX;
}
function stickNow(): void {
  const el = logPanel.value;
  if (el) el.scrollTop = el.scrollHeight;
  atBottom.value = true;
}
function onScroll(): void {
  atBottom.value = nearBottom();
}

/** 智能粘底对整份 filtered 视图生效：筛选/清空/恢复等变化后，仅在用户处于底部时跟随最新。 */
watch(filtered, () => {
  if (atBottom.value && !paused.value) void nextTick().then(() => stickNow());
});

/**
 * 智能粘底：仅当距底 ≤24px 才滚到最新，上翻看历史不打断。
 * 暂停时只缓冲不展示，恢复后 flush 再粘底。
 */
async function push(e: LogEntryDto): Promise<void> {
  if (paused.value) {
    if (!seen.has(entryKey(e))) {
      pending.push(e);
      pausedNew.value += 1;
    }
    return;
  }
  const stick = nearBottom();
  if (!append(e)) return;
  if (stick) {
    await nextTick();
    stickNow();
  }
}

function flushPending(): void {
  for (const e of pending) append(e);
  pending = [];
  pausedNew.value = 0;
}

watch(paused, (v) => {
  if (!v) {
    flushPending();
    void nextTick().then(() => stickNow());
  }
});

function clearLogs(): void {
  logs.value = [];
  seen.clear();
  pending = [];
  pausedNew.value = 0;
  stickNow();
}

/* ------------------------------ 字号记忆 ------------------------------ */

const fontSize = ref<number>(readFontSize());
function readFontSize(): number {
  try {
    const n = Number(localStorage.getItem(FONT_KEY));
    return Number.isFinite(n) && n >= 10 && n <= 20 ? n : 13;
  } catch {
    return 13;
  }
}
function changeFontSize(d: number): void {
  fontSize.value = Math.max(10, Math.min(20, fontSize.value + d));
}
watch(fontSize, (n) => {
  try {
    localStorage.setItem(FONT_KEY, String(n));
  } catch {
    /* localStorage 不可用时忽略 */
  }
});

/* ------------------------------ 全屏 ------------------------------ */

const terminalRef = ref<HTMLElement | null>(null);
const isFullscreen = ref(false);
function toggleFullscreen(): void {
  const el = terminalRef.value;
  if (!el) return;
  if (document.fullscreenElement) void document.exitFullscreen();
  else void el.requestFullscreen?.();
}
function onFullscreenChange(): void {
  isFullscreen.value = document.fullscreenElement === terminalRef.value;
}

/* ------------------------------ 导出 ------------------------------ */

type ExportRange = '1h' | '12h' | '1d' | 'all';
const exportDialog = ref(false);
const exportRange = ref<ExportRange>('all');
const exportRedact = ref(true);
const exportRanges: Array<{ title: string; value: ExportRange }> = [
  { title: '最近 1 小时', value: '1h' },
  { title: '最近 12 小时', value: '12h' },
  { title: '最近 1 天', value: '1d' },
  { title: '全部', value: 'all' },
];

const REDACT_PATTERNS: RegExp[] = [
  /sk-[A-Za-z0-9_-]{8,}/g,
  /(?:api[_-]?key|authorization|token|password|secret)\s*[:=]\s*["']?[A-Za-z0-9._-]{8,}/gi,
  /Bearer\s+[A-Za-z0-9._-]{8,}/gi,
];
function redact(text: string): string {
  let out = text;
  for (const p of REDACT_PATTERNS) out = out.replace(p, '[REDACTED]');
  return out;
}
function exportLine(e: LogEntryDto): string {
  const run = e.context?.runId ? ` [${e.context.runId}]` : '';
  const meta = metaText(e);
  return `[${e.time}] [${e.level.toUpperCase()}]${run} ${e.msg}${meta ? ' | ' + meta : ''}`;
}
function doExport(): void {
  const spans: Record<ExportRange, number> = {
    '1h': 3600e3,
    '12h': 12 * 3600e3,
    '1d': 24 * 3600e3,
    all: 0,
  };
  const span = spans[exportRange.value];
  const cutoff = span === 0 ? 0 : Date.now() - span;
  const lines = logs.value
    .filter((e) => {
      if (cutoff === 0) return true;
      const t = Date.parse(e.time);
      return Number.isNaN(t) || t >= cutoff; // 无法解析时间戳的条目保留
    })
    .map(exportLine);
  let text = lines.join('\n');
  if (exportRedact.value) text = redact(text);
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `harness-console-${new Date().toISOString().replace(/[:.]/g, '-')}.log`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
  exportDialog.value = false;
  notify(`已导出 ${lines.length} 条日志`, 'success');
}

/* ------------------------------ 其它 ------------------------------ */

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    return (
      d.toLocaleTimeString('zh-CN', { hour12: false }) +
      '.' +
      String(d.getMilliseconds()).padStart(3, '0')
    );
  } catch {
    return iso;
  }
}

/* ------------------------------ 生命周期 ------------------------------ */

/** 先拉历史 → 再开 SSE；顺序保证首屏不空白且 SSE 回放可与 REST 去重。 */
onMounted(async () => {
  document.addEventListener('fullscreenchange', onFullscreenChange);
  await loadHistory();
  connect();
});

onUnmounted(() => {
  isUnmounted = true; // 阻止在途重连
  if (reconnectTimer !== null) clearTimeout(reconnectTimer);
  if (debounceTimer !== null) clearTimeout(debounceTimer);
  closeStream?.();
  closeStream = null;
  document.removeEventListener('fullscreenchange', onFullscreenChange);
});
</script>

<style scoped>
/* 设计系统变量优先；未定义时回退到 Vuetify 主题变量（自动适配亮/暗主题，不硬编码深色背景）。 */
.console-root {
  --c-fg: var(--fg, rgb(var(--v-theme-on-surface)));
  --c-muted: var(--muted, rgba(var(--v-theme-on-surface), 0.55));
  --c-border: var(--border, rgba(var(--v-theme-on-surface), 0.12));
  --c-surface: var(--surface, rgb(var(--v-theme-surface)));
  --c-accent: var(--accent, rgb(var(--v-theme-primary)));
  --c-success: var(--success, rgb(var(--v-theme-success)));
  --c-warning: var(--warning, rgb(var(--v-theme-warning)));
  --c-error: var(--error, rgb(var(--v-theme-error)));
  --c-c1: var(--c1, rgb(var(--v-theme-info)));
  --c-c2: var(--c2, rgb(var(--v-theme-primary)));
  --c-c3: var(--c3, rgb(var(--v-theme-warning)));
  --c-c4: var(--c4, rgb(var(--v-theme-error)));
  --c-c5: var(--c5, rgb(var(--v-theme-success)));
  --c-c6: var(--c6, rgb(var(--v-theme-secondary)));
}

.console-body {
  min-width: 0;
}
.filter-panel {
  width: 232px;
  min-width: 232px;
}
.panel-title {
  font-size: 0.7rem;
  font-weight: 600;
  letter-spacing: 0.04em;
  color: var(--c-muted);
  margin-bottom: 6px;
  text-transform: uppercase;
}
.level-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 3px 4px;
  border: 0;
  background: transparent;
  color: var(--c-fg);
  font: inherit;
  font-size: 0.8rem;
  cursor: pointer;
  border-radius: 6px;
  text-align: left;
}
.level-item:hover {
  background: color-mix(in srgb, var(--c-fg) 4%, transparent);
}
.level-dot {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  flex-shrink: 0;
}
.dot-debug { background: var(--c-c1); }
.dot-info  { background: var(--c-c2); }
.dot-warn  { background: var(--c-c3); }
.dot-error { background: var(--c-c4); }
.level-label { flex: 1; }
.level-count { color: var(--c-muted); font-size: 0.72rem; }

.stat-line {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 0.76rem;
  color: var(--c-fg);
  padding: 2px 0;
}

/* ── 终端：多层 flex，逐层 min-height:0 保证 overflow 生效 ── */
.terminal-wrap {
  position: relative;
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
}
.terminal-wrap:fullscreen {
  padding: 10px;
  background: var(--c-surface);
}
.terminal {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
  position: relative;
  background: var(--c-surface);
  border: 1px solid var(--c-border);
  border-radius: var(--panel-border-radius);
  overflow: hidden;
}
.terminal-scroll {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  color: var(--c-fg);
  font-family: var(--font-mono);
  line-height: 1.5;
  padding: 6px 0;
}
.terminal-hint {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  gap: 6px;
  color: var(--c-muted);
  font-size: 0.85rem;
  text-align: center;
  padding: 16px;
}
.terminal-error { color: var(--c-error); }

.log-row {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 2px 12px;
  white-space: pre-wrap;
  word-break: break-word;
  border-bottom: 1px solid var(--c-border);
}
.log-row:hover { background: color-mix(in srgb, var(--c-fg) 3%, transparent); }
.row-warn  { box-shadow: inset 3px 0 0 var(--c-warning); }
.row-error { box-shadow: inset 3px 0 0 var(--c-error); }

/* 三段：时间 / 等级 / 消息 */
.seg-time {
  flex-shrink: 0;
  color: var(--c-muted);
  font-size: 0.92em;
}
.seg-level {
  flex-shrink: 0;
  min-width: 48px;
  text-align: center;
  font-weight: 700;
  font-size: 0.9em;
}
.lvl-debug { color: var(--c-c1); }
.lvl-info  { color: var(--c-c2); }
.lvl-warn  { color: var(--c-c3); }
.lvl-error { color: var(--c-c4); }
.seg-msg { flex: 1; min-width: 0; }
.run-tag { color: var(--c-muted); margin-right: 6px; }
.meta-tag { color: var(--c-muted); margin-left: 8px; font-size: 0.9em; }
.hl {
  background: var(--c-accent);
  color: var(--c-surface);
  border-radius: 2px;
  padding: 0 1px;
}

.jump-latest {
  position: absolute;
  right: 18px;
  bottom: 14px;
}

.font-ctl { border: 1px solid var(--c-border); border-radius: 8px; }
</style>
