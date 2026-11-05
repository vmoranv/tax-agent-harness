<template>
  <div class="d-flex flex-column fill-height" style="height: 100%">
    <v-row no-gutters class="fill-height">
      <!-- ════════════════════ 左侧：对话与工具流 ════════════════════ -->
      <v-col class="d-flex flex-column pr-lg-3 fill-height">
        <v-card
          variant="outlined"
          class="d-flex flex-column flex-fill overflow-hidden gpu-accelerated"
          style="border-radius: var(--panel-border-radius); border-color: rgba(var(--v-border-color), 0.12)"
        >
          <!-- 顶栏：身份作用域与权限守卫 -->
          <div
            class="px-4 py-2 d-flex align-center ga-3"
            style="border-bottom: 1px solid rgba(var(--v-border-color), 0.08); background-color: rgba(var(--v-theme-surface), 0.75)"
          >
            <v-icon size="16" class="text-medium-emphasis">mdi-account-outline</v-icon>
            <v-select
              v-model="session.userId"
              :items="session.users"
              item-title="display_name"
              item-value="id"
              variant="plain"
              density="compact"
              hide-details
              class="flex-grow-0"
              style="min-width: 150px"
              @update:model-value="onUserChanged($event)"
            />
            <v-icon size="14" class="text-medium-emphasis">mdi-chevron-right</v-icon>
            <v-select
              v-model="session.enterpriseId"
              :items="enterpriseOptions"
              item-title="label"
              item-value="id"
              variant="plain"
              density="compact"
              hide-details
              class="flex-grow-0"
              style="min-width: 140px"
              :disabled="loading"
              @update:model-value="onEnterpriseChanged($event)"
            />
            <v-spacer />
            <v-chip
              size="x-small"
              variant="tonal"
              :color="permissionColor"
              class="text-caption font-weight-medium"
            >
              {{ permissionLabel }}
            </v-chip>
          </div>

          <!-- 消息流容器 -->
          <div
            ref="listRef"
            class="flex-fill overflow-y-auto px-4 py-3"
            @scroll="handleScroll"
          >
            <!-- 初始空态：隐形引导 -->
            <div
              v-if="messages.length === 0 && !loading"
              class="d-flex flex-column align-center justify-center fill-height text-medium-emphasis"
            >
              <v-icon size="36" class="mb-3" style="opacity: 0.35">mdi-text-box-search-outline</v-icon>
              <div class="text-body-2 font-weight-medium mb-1">选择企业主体，开始财税任务处理</div>
              <div class="text-caption" style="max-width: 380px; text-align: center; opacity: 0.8">
                支持金额分列统计、规则合规检查、发票用途回写复核与跨会话断点续跑。
              </div>
            </div>

            <TransitionGroup name="msg" tag="div">
              <template v-for="m in messages" :key="m.id">
                <!-- 用户气泡 -->
                <div v-if="m.role === 'user'" class="d-flex justify-end mb-4">
                  <div class="user-bubble text-body-2">
                    {{ m.content }}
                  </div>
                </div>

                <!-- 助手消息 -->
                <div v-else-if="m.role === 'assistant'" class="d-flex mb-4">
                  <v-avatar size="26" color="primary" variant="tonal" class="mr-3 mt-1 flex-shrink-0">
                    <v-icon size="14">mdi-file-document-edit-outline</v-icon>
                  </v-avatar>
                  <div class="flex-grow-1" style="max-width: 86%">
                    <div class="d-flex align-center ga-2 mb-1">
                      <span class="text-caption font-weight-medium">财税助手</span>
                      <span v-if="m.model" class="text-caption text-disabled tabular-nums">{{ m.model }}</span>
                    </div>
                    <div class="assistant-content text-body-2" v-html="renderMessageWithProvenance(m.content)" />
                  </div>
                </div>

                <!-- 工具调用卡片（行内可折叠证据） -->
                <div v-else-if="m.role === 'tool'" class="mb-3 ml-9">
                  <v-expansion-panels density="compact" variant="accordion" style="max-width: 640px">
                    <v-expansion-panel
                      :id="`tool-${m.name}`"
                      :class="{ 'prov-highlighted': highlightedTool === m.name }"
                    >
                      <v-expansion-panel-title class="text-caption py-1">
                        <span class="d-inline-flex align-center">
                          <v-icon size="14" :color="m.ok ? 'success' : 'error'" class="mr-2">
                            {{ m.ok ? 'mdi-check-circle-outline' : 'mdi-alert-circle-outline' }}
                          </v-icon>
                          <span class="font-weight-medium tabular-nums">{{ m.name }}</span>
                        </span>
                        <template #actions>
                          <span class="text-caption text-medium-emphasis">{{ m.ok ? '已核验' : '返回异常' }}</span>
                        </template>
                      </v-expansion-panel-title>
                      <v-expansion-panel-text>
                        <pre class="tool-pre">{{ pretty(m.data) }}</pre>
                      </v-expansion-panel-text>
                    </v-expansion-panel>
                  </v-expansion-panels>
                </div>

                <!-- 异常报警条 -->
                <v-alert
                  v-else-if="m.role === 'error'"
                  type="error"
                  density="compact"
                  variant="tonal"
                  class="mb-3 ml-9"
                  style="border-radius: 8px"
                >
                  <div class="text-caption">{{ m.content }}</div>
                </v-alert>
              </template>
            </TransitionGroup>

            <!-- 脉冲流式指示器 -->
            <div v-if="loading" class="d-flex align-center ga-2 ml-9 mt-2 text-medium-emphasis">
              <span class="status-dot" style="background-color: rgb(var(--v-theme-primary))" />
              <span class="text-caption">正在执行业务计算与复核校验…</span>
            </div>
          </div>

          <!-- 场景快速触发点（克制芯片） -->
          <div v-if="!liveMode" class="px-4 pb-2 pt-1 d-flex ga-2 flex-wrap align-center">
            <span class="text-caption text-medium-emphasis mr-1">验证场景</span>
            <v-chip
              v-for="sc in scenarioList"
              :key="sc.key"
              size="small"
              variant="outlined"
              :disabled="loading"
              class="clickable-row tabular-nums"
              @click="runScenario(sc.key)"
            >
              {{ sc.label }}
            </v-chip>
            <v-tooltip location="top" open-delay="200">
              <template #activator="{ props }">
                <v-icon v-bind="props" size="14" class="text-disabled ml-1">mdi-help-circle-outline</v-icon>
              </template>
              测试模式（离线用例驱动）用确定性关键词路由真实用例与 SQLite 数据库回放，非模型理解、仅用于无 LLM 时调试闭环；正式演示请配置 HARNESS_LLM_* 走在线主链路
            </v-tooltip>
          </div>

          <!-- 输入区 -->
          <div class="px-4 pb-3 pt-2">
            <div class="input-shell d-flex align-end pa-2">
              <v-textarea
                v-model="draft"
                :placeholder="inputPlaceholder"
                :disabled="loading"
                variant="plain"
                density="compact"
                auto-grow
                rows="1"
                max-rows="5"
                hide-details
                class="flex-grow-1"
                @keydown.enter.exact.prevent="sendMessage"
              />
              <v-btn
                icon="mdi-arrow-up"
                size="small"
                color="primary"
                variant="flat"
                :disabled="loading || draft.trim() === ''"
                aria-label="发送"
                class="ml-2 mb-1 flex-shrink-0"
                @click="sendMessage"
              />
            </div>
            <div class="d-flex justify-space-between align-center mt-2 px-1">
              <span class="text-caption text-disabled">Enter 发送 · Shift+Enter 换行</span>
              <div class="d-flex align-center ga-2">
                <span class="text-caption" :class="liveMode ? 'text-primary font-weight-medium' : 'text-medium-emphasis'">
                  {{ liveMode ? '大模型在线' : '离线用例驱动' }}
                </span>
                <v-tooltip location="top" open-delay="200">
                  <template #activator="{ props }">
                    <v-switch
                      v-bind="props"
                      v-model="liveMode"
                      density="compact"
                      hide-details
                      color="primary"
                      :disabled="!session.llmConfigured"
                    />
                  </template>
                  {{ session.llmConfigured ? '在线大模型 = 主链路（真实模型负责理解与决策）；离线用例驱动用确定性关键词路由真实用例，不是模型理解，仅用于无 LLM 时调试' : '未配置 LLM（HARNESS_LLM_*），仅离线用例驱动（脚本回放 / 关键词调试降级，非模型理解）可用；正式演示请接入 HARNESS_LLM_* 走在线主链路' }}
                </v-tooltip>
              </div>
            </div>
            <div class="text-caption text-disabled mt-1 px-1">离线用例驱动 = 脚本回放 / 关键词确定性路由的调试降级模式（非模型理解），仅用于无 LLM 时自测；正式演示须配置 HARNESS_LLM_* 接入大模型在线主链路（真实模型负责理解与决策）。</div>
          </div>
        </v-card>
      </v-col>

      <!-- ════════════════════ 右侧：三面板证据链 ════════════════════ -->
      <v-col cols="12" lg="5" class="fill-height pt-4 pt-lg-0 pl-lg-3">
        <v-card
          variant="outlined"
          class="fill-height d-flex flex-column overflow-hidden gpu-accelerated"
          style="border-radius: var(--panel-border-radius); border-color: rgba(var(--v-border-color), 0.12)"
        >
          <!-- 顶部三标签栏 -->
          <v-tabs
            v-model="activeTab"
            color="primary"
            density="compact"
            grow
            class="flex-shrink-0"
            style="border-bottom: 1px solid rgba(var(--v-border-color), 0.08)"
          >
            <v-tab value="task" class="text-caption font-weight-medium">
              <v-icon size="15" class="mr-1">mdi-clipboard-list-outline</v-icon>
              任务卡
              <v-badge
                v-if="activeCardPendingCount > 0"
                :content="activeCardPendingCount"
                color="primary"
                inline
                class="ml-1"
              />
            </v-tab>
            <v-tab value="rules" class="text-caption font-weight-medium">
              <v-icon size="15" class="mr-1">mdi-scale-balance</v-icon>
              适用规则
            </v-tab>
            <v-tab value="trace" class="text-caption font-weight-medium">
              <v-icon size="15" class="mr-1">mdi-timeline-text-outline</v-icon>
              执行证据
            </v-tab>
          </v-tabs>

          <!-- 标签内容滚动区 -->
          <div class="flex-fill overflow-y-auto pa-3">
            <!-- ─── TAB 1: 任务卡面板 ─── -->
            <div v-if="activeTab === 'task'">
              <div v-if="taskCard === null" class="pa-4 text-center text-medium-emphasis">
                <v-icon size="32" class="mb-2" style="opacity: 0.35">mdi-tray-minus</v-icon>
                <div class="text-caption">当前企业暂无进行中的发票处理任务</div>
              </div>
              <div v-else class="pa-1">
                <!-- 头部状态行 -->
                <div class="d-flex align-center justify-space-between mb-3">
                  <div class="d-flex align-center ga-2">
                    <v-chip
                      size="x-small"
                      :color="taskCard.status === 'active' ? 'primary' : 'success'"
                      variant="tonal"
                      class="font-weight-medium"
                    >
                      {{ taskCard.status === 'active' ? '进行中' : '已归档' }}
                    </v-chip>
                    <span class="text-caption text-medium-emphasis tabular-nums">
                      {{ taskCard.enterpriseId }} · {{ taskCard.month }}
                    </span>
                  </div>
                  <span class="text-caption text-disabled tabular-nums">rev. {{ taskCard.revision }}</span>
                </div>

                <!-- 待办清单 -->
                <div class="text-caption font-weight-medium text-medium-emphasis mb-2 d-flex align-center">
                  <span>待补充发票 ({{ taskCard.pending.length }})</span>
                </div>
                <div v-if="taskCard.pending.length === 0" class="text-caption text-disabled mb-3">
                  全量发票用途已补全
                </div>
                <div v-else class="d-flex flex-wrap ga-1 mb-3">
                  <v-chip
                    v-for="item in taskCard.pending"
                    :key="item.ref"
                    size="small"
                    variant="tonal"
                    color="warning"
                    class="tabular-nums"
                  >
                    {{ item.ref }}
                  </v-chip>
                </div>

                <!-- 已完成清单 -->
                <div class="text-caption font-weight-medium text-medium-emphasis mb-2">
                  已完成发票 ({{ taskCard.completed.length }})
                </div>
                <div v-if="taskCard.completed.length === 0" class="text-caption text-disabled mb-3">
                  暂无已完成项
                </div>
                <div v-else class="d-flex flex-wrap ga-1 mb-3">
                  <v-chip
                    v-for="item in taskCard.completed"
                    :key="item.ref"
                    size="small"
                    variant="tonal"
                    color="success"
                    class="tabular-nums"
                  >
                    {{ item.ref }}
                  </v-chip>
                </div>

                <v-divider class="my-2" />
                <div class="text-caption text-disabled tabular-nums">
                  更新时间：{{ taskCard.updatedAt }}
                </div>
              </div>
            </div>

            <!-- ─── TAB 2: 适用规则面板 ─── -->
            <div v-else-if="activeTab === 'rules'">
              <div class="text-caption text-medium-emphasis mb-2">
                当前依据解析 ({{ session.enterpriseName(session.enterpriseId ?? '') }} · 2026-09)
              </div>
              <v-list density="compact" class="py-0">
                <v-list-item
                  v-for="r in currentApplicableRules"
                  :key="r.code + r.version"
                  class="mb-2 clickable-row"
                  style="border: 1px solid rgba(var(--v-border-color), 0.08); border-radius: 8px"
                  @click="toggleRuleBody(r.code)"
                >
                  <template #prepend>
                    <v-icon size="16" :color="r.status === 'enabled' ? 'success' : 'grey'">
                      {{ r.status === 'enabled' ? 'mdi-check-circle-outline' : 'mdi-cancel' }}
                    </v-icon>
                  </template>
                  <v-list-item-title class="text-body-2 font-weight-medium">
                    {{ r.code }}《{{ r.title }}》 v{{ r.version }}
                  </v-list-item-title>
                  <v-list-item-subtitle class="text-caption text-medium-emphasis mt-1">
                    {{ r.obligation?.summary || r.scope }}
                  </v-list-item-subtitle>
                  <div
                    v-if="expandedRules.has(r.code)"
                    class="rule-body-callout text-caption mt-2"
                  >
                    {{ r.body }}
                  </div>
                </v-list-item>
              </v-list>
            </div>

            <!-- ─── TAB 3: 执行记录与数字溯源 ─── -->
            <div v-else-if="activeTab === 'trace'">
              <div v-if="activeRunId === null" class="pa-4 text-center text-medium-emphasis">
                <v-icon size="32" class="mb-2" style="opacity: 0.35">mdi-timeline-outline</v-icon>
                <div class="text-caption">发起任意提问或点击验证场景后，将实时渲染证据调用链</div>
              </div>
              <div v-else>
                <!-- 运行概要条 -->
                <div class="d-flex align-center justify-space-between mb-3 px-1">
                  <span class="text-caption text-medium-emphasis font-weight-medium">执行流水</span>
                  <span class="text-caption tabular-nums text-disabled">{{ activeRunId }}</span>
                </div>

                <!-- 工具调用序列 -->
                <div class="text-caption text-medium-emphasis mb-1 font-weight-medium">调用步骤</div>
                <div v-if="runTools.length === 0" class="text-caption text-disabled mb-3">无工具执行</div>
                <div v-else class="mb-3">
                  <div
                    v-for="(t, i) in runTools"
                    :key="i"
                    :id="`trace-tool-${t.name}`"
                    class="tool-step-card pa-2 mb-1 clickable-row"
                  >
                    <div class="d-flex align-center justify-space-between">
                      <div class="d-flex align-center ga-2">
                        <v-icon size="14" :color="t.ok ? 'success' : 'error'">
                          {{ t.ok ? 'mdi-check' : 'mdi-close' }}
                        </v-icon>
                        <span class="text-caption font-weight-medium tabular-nums">{{ t.name }}</span>
                      </div>
                      <span class="text-caption text-disabled tabular-nums">{{ t.elapsedMs }}ms</span>
                    </div>
                  </div>
                </div>

                <!-- 数字溯源映射表 -->
                <v-divider class="my-3" />
                <div class="text-caption text-medium-emphasis mb-2 font-weight-medium">数字溯源核验</div>
                <div v-if="runProvenance.length === 0" class="text-caption text-disabled">
                  未检测到数值类输出
                </div>
                <div v-else class="d-flex flex-column ga-1">
                  <div
                    v-for="(p, i) in runProvenance"
                    :key="i"
                    class="d-flex align-center justify-space-between pa-1 px-2"
                    style="border: 1px solid rgba(var(--v-border-color), 0.08); border-radius: 6px"
                  >
                    <div class="d-flex align-center ga-2">
                      <v-icon size="12" :color="p.ok ? 'success' : 'error'">mdi-circle</v-icon>
                      <span class="text-caption tabular-nums font-weight-medium">{{ p.literal }}</span>
                    </div>
                    <span class="text-caption text-disabled text-truncate" style="max-width: 180px">
                      {{ p.source }}
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </v-card>
      </v-col>
    </v-row>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import {
  chatLive,
  chatOffline,
  chatScript,
  chatStream,
  fetchTaskCard,
  type ProvenanceDto,
  type TaskCardDto,
  type ToolCallDto,
} from '@/api/harness';
import { useSessionStore } from '@/stores/session';
import { useToastStore } from '@/stores/toast';

const session = useSessionStore();
const toast = useToastStore();

/* ------------------------------ 基础状态 ------------------------------ */

interface ChatMessage {
  id: number;
  role: 'user' | 'assistant' | 'tool' | 'error';
  content: string;
  name?: string;
  ok?: boolean;
  data?: unknown;
  model?: string;
}

let msgSeq = 0;
function createMsg(
  role: ChatMessage['role'],
  content: string,
  extra: Partial<ChatMessage> = {},
): ChatMessage {
  return { id: ++msgSeq, role, content, ...extra };
}

const messages = ref<ChatMessage[]>([]);
const draft = ref('');
const loading = ref(false);
const listRef = ref<HTMLElement>();
const shouldStickBottom = ref(true);

const liveMode = ref(false);
const activeTab = ref<'task' | 'rules' | 'trace'>('task');
const activeRunId = ref<string | null>(null);
const runTools = ref<ToolCallDto[]>([]);
const runProvenance = ref<ProvenanceDto[]>([]);
const highlightedTool = ref<string | null>(null);

const taskCard = ref<TaskCardDto | null>(null);
const expandedRules = ref<Set<string>>(new Set());

/* ------------------------------ 场景触发点 ------------------------------ */

const scenarioList = [
  { key: 'query', label: '1. 查 9 月金额 (分列核验)' },
  { key: 'gaps', label: '2. 查 9 月缺项 (门槛陷阱)' },
  { key: 'save', label: '3. 补 F002 用途 (回写复核)' },
] as const;

const SCENARIOS: Record<
  string,
  {
    question: string;
    turns: Array<
      Array<{ type: 'text' | 'tool-call'; content?: string; name?: string; args?: unknown }>
    >;
  }
> = {
  query: {
    question: '甲企业 2026 年 9 月的发票和银行收支各是多少？',
    turns: [
      [{ type: 'tool-call', name: 'summarize_enterprise_month', args: { month: '2026-09' } }],
      [{ type: 'text', content: '' }],
    ],
  },
  gaps: {
    question: '9 月有哪些发票没填用途？',
    turns: [
      [{ type: 'tool-call', name: 'find_purpose_gaps', args: { month: '2026-09' } }],
      [{ type: 'text', content: '' }],
    ],
  },
  save: {
    question: '把 F002 的用途填成「办公用品采购」',
    turns: [
      [
        {
          type: 'tool-call',
          name: 'set_invoice_purpose',
          args: { invoiceNo: 'F002', purpose: '办公用品采购' },
        },
      ],
      [{ type: 'text', content: '' }],
    ],
  },
};

/* ------------------------------ 计算属性 ------------------------------ */

const inputPlaceholder = computed(() => {
  if (loading.value) return '正在执行业务校验与写入复核…';
  if (!liveMode.value)
    return '输入财税问题，离线模式将路由到真实用例（如：查 9 月金额 / 查缺项 / 把 F002 用途填成办公用品采购）';
  return `向 ${session.enterpriseName(session.enterpriseId ?? '')} 提出财税任务…`;
});

const permissionColor = computed(() => {
  const l = session.currentLevel;
  return l === 'read-write' ? 'success' : l === 'read-only' ? 'info' : 'grey';
});

const permissionLabel = computed(() => {
  const l = session.currentLevel;
  return l === 'read-write' ? '可读写' : l === 'read-only' ? '仅查看' : '无权访问';
});

const enterpriseOptions = computed(
  () =>
    session.users
      .find((u) => u.id === session.userId)
      ?.grants.filter((g) => g.level !== 'none')
      .map((g) => ({ id: g.enterpriseId, label: session.enterpriseName(g.enterpriseId) })) ?? [],
);

const activeCardPendingCount = computed(() => taskCard.value?.pending.length ?? 0);

const currentApplicableRules = computed(() => {
  const eid = session.enterpriseId;
  return session.rules.filter((r) => r.scope === '通用' || r.scope.includes(eid ?? ''));
});

/* ------------------------------ 滚动与交互 ------------------------------ */

function handleScroll(): void {
  if (!listRef.value) return;
  const { scrollTop, scrollHeight, clientHeight } = listRef.value;
  shouldStickBottom.value = scrollHeight - scrollTop - clientHeight < 60;
}

function scrollToBottom(): void {
  if (!shouldStickBottom.value) return;
  void nextTick(() => {
    if (listRef.value) {
      listRef.value.scrollTo({ top: listRef.value.scrollHeight, behavior: 'smooth' });
    }
  });
}

function toggleRuleBody(code: string): void {
  if (expandedRules.value.has(code)) {
    expandedRules.value.delete(code);
  } else {
    expandedRules.value.add(code);
  }
}

function pretty(data: unknown): string {
  return JSON.stringify(data, null, 2);
}

/* ------------------------------ 溯源徽标渲染 ------------------------------ */

/**
 * 隐形视觉引导核心：将助手回复中的金额转化为可交互点击的溯源徽标。
 */
function renderMessageWithProvenance(raw: string): string {
  if (!raw) return '';
  const escaped = raw.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  // 匹配形如 9,622.06 或 1,000.00
  return escaped.replace(/(\b\d{1,3}(?:,\d{3})*\.\d{2}\b)/g, (val) => {
    return `<span class="prov-literal tabular-nums font-weight-medium" data-val="${val}">${val}</span>`;
  });
}

/* ------------------------------ 数据加载 ------------------------------ */

async function reloadTaskCard(): Promise<void> {
  if (!session.userId || !session.enterpriseId) return;
  try {
    taskCard.value = await fetchTaskCard(session.userId, session.enterpriseId);
  } catch {
    taskCard.value = null;
  }
}

function onUserChanged(uid: string): void {
  session.selectUser(uid);
  void reloadTaskCard();
}

function onEnterpriseChanged(eid: string): void {
  session.selectEnterprise(eid);
  void reloadTaskCard();
}

onMounted(async () => {
  try {
    await session.bootstrapMeta();
    await reloadTaskCard();
  } catch (err) {
    toast.error('加载系统元数据失败：' + (err instanceof Error ? err.message : String(err)));
  }

  // 全局代理点击溯源徽标
  listRef.value?.addEventListener('click', (e) => {
    const target = (e.target as HTMLElement)?.closest('.prov-literal');
    if (target) {
      activeTab.value = 'trace';
      const literal = target.getAttribute('data-val');
      const found = runProvenance.value.find((p) => p.literal === literal);
      if (found) {
        highlightedTool.value = found.source.split('#')[0] ?? null;
      }
    }
  });
});

/* ------------------------------ 场景执行逻辑 ------------------------------ */

function renderToolSummary(name: string, data: unknown): string {
  const d = data as Record<string, unknown>;
  if (name === 'summarize_enterprise_month' && d?.invoice && d?.bank) {
    const inv = d.invoice as { count: number; total: string };
    const bank = d.bank as { expense: string; income: string };
    const rules = (d.rules as string[]) ?? [];
    return (
      `${d.enterprise} ${d.month}：发票共 ${inv.count} 张，价税合计 ${inv.total} 元；` +
      `银行支出 ${bank.expense} 元，收入 ${bank.income} 元。\n` +
      `金额统计依据：《${rules.find((r) => r.includes('R001')) ?? 'R001 金额统计说明'}》。` +
      `两类数据收支分列，金额不要求相等。`
    );
  }
  if (name === 'find_purpose_gaps' && d?.gaps) {
    const gaps = d.gaps as Array<{ invoiceNo: string }>;
    const optional = (d.optional as Array<{ invoiceNo: string }>) ?? [];
    return (
      `${d.enterprise} ${d.month} 依据 ${String(d.rule ?? '')}：\n` +
      `• 必填但空着 (${gaps.length} 张)：${gaps.map((g) => g.invoiceNo).join('、')}\n` +
      (optional.length > 0
        ? `• 允许为空 (${optional.length} 张)：${optional.map((g) => g.invoiceNo).join('、')} (低于门槛免填)`
        : '• 无免填项')
    );
  }
  if (name === 'set_invoice_purpose' && d) {
    const o = d as { invoiceNo: string; before: string | null; after: string; changed: boolean };
    return o.changed
      ? `已成功将发票 ${o.invoiceNo} 用途从「${o.before ?? '（空）'}」修改为「${o.after}」，经回读复核完全一致。`
      : `发票 ${o.invoiceNo} 当前用途已为目标值，无需重复写入。`;
  }
  if (name === 'set_invoice_remark' && d) {
    const o = d as { invoiceNo: string; changed: boolean; after: string };
    return o.changed
      ? `已成功将发票 ${o.invoiceNo} 备注修改为「${o.after}」。`
      : `发票 ${o.invoiceNo} 当前备注已为目标值，无需重复写入。`;
  }
  return JSON.stringify(data, null, 2);
}

/** 离线/脚本结果统一渲染：工具卡片 + 证据面板 + 助手汇总。 */
function applyOfflineResult(r: {
  runId: string | null;
  text: string;
  steps: Array<{ name: string; ok: boolean; data: unknown }>;
  clarified?: boolean;
}): void {
  if (r.runId !== null) activeRunId.value = r.runId;
  for (const [i, st] of r.steps.entries()) {
    messages.value.push(createMsg('tool', '', { name: st.name, ok: st.ok, data: st.data }));
    runTools.value.push({
      id: `${i}-${st.name}`,
      name: st.name,
      ok: st.ok,
      result: st.data,
      elapsedMs: 0,
    });
  }

  // 澄清文本（未命中工具）直接作为助手回复；其余用真实工具结果生成汇总。
  const finalText =
    r.clarified === true || r.text.trim() === '' || r.text === '演示完成'
      ? r.steps.length > 0
        ? r.steps
            .filter((s) => s.ok)
            .map((s) => renderToolSummary(s.name, s.data))
            .join('\n\n')
        : r.text
      : r.text;

  messages.value.push(createMsg('assistant', finalText || '（已完成）'));
  scrollToBottom();
}

async function runScenario(key: string): Promise<void> {
  const sc = SCENARIOS[key];
  if (!sc || loading.value) return;

  messages.value.push(createMsg('user', sc.question));
  loading.value = true;
  activeRunId.value = null;
  runTools.value = [];
  runProvenance.value = [];
  scrollToBottom();

  try {
    const r = await chatScript({
      text: sc.question,
      userId: session.userId ?? 'U001',
      enterpriseId: session.enterpriseId ?? 'C001',
      turns: sc.turns,
    });
    applyOfflineResult(r);
    await reloadTaskCard();
  } catch (err) {
    messages.value.push(createMsg('error', err instanceof Error ? err.message : String(err)));
  } finally {
    loading.value = false;
    scrollToBottom();
  }
}

/* ------------------------------ 发送：在线 / 离线 ------------------------------ */

async function sendMessage(): Promise<void> {
  const text = draft.value.trim();
  if (text === '' || loading.value) return;

  messages.value.push(createMsg('user', text));
  draft.value = '';
  loading.value = true;
  activeRunId.value = null;
  runTools.value = [];
  runProvenance.value = [];
  scrollToBottom();

  if (liveMode.value) {
    await sendOnline(text);
  } else {
    try {
      const r = await chatOffline({
        text,
        userId: session.userId ?? 'U001',
        enterpriseId: session.enterpriseId ?? 'C001',
      });
      applyOfflineResult(r);
      await reloadTaskCard();
    } catch (err) {
      messages.value.push(createMsg('error', err instanceof Error ? err.message : String(err)));
    } finally {
      loading.value = false;
      scrollToBottom();
    }
  }
}

async function sendOnline(text: string): Promise<void> {
  const handleFail = (msgText: string): void => {
    messages.value.push(createMsg('error', msgText));
    toast.error('执行未能确认完成');
    loading.value = false;
    scrollToBottom();
  };

  try {
    chatStream(
      { text, userId: session.userId ?? 'U001', enterpriseId: session.enterpriseId ?? 'C001' },
      {
        onStarted: (runId) => {
          activeRunId.value = runId;
        },
        onTool: (name, ok) => {
          runTools.value.push({
            id: `${name}-${Date.now()}`,
            name,
            ok,
            result: null,
            elapsedMs: 25,
          });
          messages.value.push(createMsg('tool', '', { name, ok }));
          scrollToBottom();
        },
        onDone: (runId, finalText) => {
          messages.value.push(createMsg('assistant', finalText || '（无响应内容）'));
          activeRunId.value = runId;
          loading.value = false;
          void reloadTaskCard();
          scrollToBottom();
        },
        onError: (errMsg) => {
          handleFail(errMsg);
        },
      },
    );
  } catch {
    const res = await chatLive({
      text,
      userId: session.userId ?? 'U001',
      enterpriseId: session.enterpriseId ?? 'C001',
    }).catch((e: unknown) => {
      handleFail(e instanceof Error ? e.message : String(e));
      return null;
    });

    if (res) {
      messages.value.push(createMsg('assistant', res.text));
      runTools.value = res.steps ?? [];
      runProvenance.value = res.provenance ?? [];
      activeRunId.value = res.runId;
      loading.value = false;
      void reloadTaskCard();
      scrollToBottom();
    }
  }
}
</script>

<style scoped>
/* 用户气泡：微高对比色，右上方收紧气泡半径 */
.user-bubble {
  max-width: 72%;
  padding: 10px 14px;
  border-radius: var(--bubble-border-radius) var(--bubble-border-radius) 4px var(--bubble-border-radius);
  background-color: rgb(var(--v-theme-primary));
  color: rgb(var(--v-theme-on-primary));
  white-space: pre-wrap;
  line-height: 1.6;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.08);
}

.assistant-content {
  line-height: 1.7;
}

/* 输入框外壳：极简发丝聚焦引导 */
.input-shell {
  border: 1px solid rgba(var(--v-border-color), 0.16);
  border-radius: var(--panel-border-radius);
  background-color: rgba(var(--v-theme-surface), 0.6);
  transition: border-color var(--dur-fast) var(--ease-spring);
}
.input-shell:focus-within {
  border-color: rgb(var(--v-theme-primary));
}

.tool-pre {
  max-height: 220px;
  overflow: auto;
  font-family: var(--font-mono);
  font-size: 11px;
  line-height: 1.5;
  background-color: rgba(var(--v-theme-on-surface), 0.03);
  padding: 8px;
  border-radius: 6px;
}

.rule-body-callout {
  padding: 8px 10px;
  background-color: rgba(var(--v-theme-on-surface), 0.03);
  border-radius: 6px;
  line-height: 1.6;
}

.tool-step-card {
  border: 1px solid rgba(var(--v-border-color), 0.08);
  border-radius: 6px;
}

/* 消息中的数字溯源徽标样式 */
:deep(.prov-literal) {
  cursor: pointer;
  padding: 1px 4px;
  margin: 0 1px;
  border-radius: 4px;
  background-color: rgba(var(--v-theme-primary), 0.08);
  color: rgb(var(--v-theme-primary));
  transition: all var(--dur-fast) var(--ease-spring);
}
:deep(.prov-literal:hover) {
  background-color: rgba(var(--v-theme-primary), 0.2);
  text-decoration: underline;
}
</style>
