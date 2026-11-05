<template>
  <div class="pa-4">
    <div class="d-flex align-center mb-3">
      <span class="text-body-2 text-medium-emphasis">最近 {{ runs.length }} 轮 · 点击查看证据链</span>
      <v-spacer />
      <v-btn size="small" variant="text" prepend-icon="mdi-refresh" @click="refresh">刷新</v-btn>
    </div>

    <v-empty-state
      v-if="runs.length === 0"
      icon="mdi-history"
      title="还没有运行记录"
      text="发起一轮对话后，这里会列出每次运行的证据链"
      size="compact"
    />

    <v-card
      v-for="r in runs"
      :key="r.run_id"
      variant="outlined"
      class="mb-2 clickable-row"
      style="border-radius: 10px"
      @click="openDetail(r.run_id)"
    >
      <div class="pa-3 d-flex align-center">
        <v-icon size="18" :color="r.has_error ? 'error' : 'success'" class="mr-3">
          {{ r.has_error ? 'mdi-alert-circle-outline' : 'mdi-check-circle-outline' }}
        </v-icon>
        <div class="flex-fill min-width-0">
          <div class="text-body-2 text-truncate">{{ r.final_preview || '（无文本输出）' }}</div>
          <div class="text-caption text-medium-emphasis tabular-nums mt-1">
            {{ r.run_id }} · {{ formatTime(r.started_at) }}
          </div>
        </div>
        <v-icon size="16" class="text-medium-emphasis">mdi-chevron-right</v-icon>
      </div>
    </v-card>

    <!-- 详情抽屉 -->
    <v-navigation-drawer
      v-model="drawerOpen"
      location="right"
      temporary
      width="560"
      style="border-left: 1px solid rgba(var(--v-border-color), var(--v-border-opacity))"
    >
      <div class="pa-4">
        <template v-if="detail !== null">
          <div class="text-subtitle-2 mb-3">运行 {{ detail.runId }}</div>

          <div class="text-caption font-weight-medium text-medium-emphasis mt-2 mb-1">概要</div>
          <div class="text-body-2" style="white-space: pre-wrap; line-height: 1.7">
            {{ detail.finalText || '（无文本输出）' }}
          </div>
          <div class="text-caption text-medium-emphasis mt-2 tabular-nums">
            耗时 {{ detail.elapsedMs }}ms · 模型 {{ detail.model.modelId }}
            <template v-if="detail.usage">
              · Token 输入 {{ detail.usage.inputTokens }} / 输出 {{ detail.usage.outputTokens }}
            </template>
            <template v-if="detail.error !== null">
              · <span class="text-error">{{ detail.error.code }}</span>
            </template>
          </div>
          <v-divider class="my-3" />

          <div class="text-caption font-weight-medium text-medium-emphasis mb-1">
            模型输入 / 脚本上下文（本轮实际装配）
          </div>
          <pre class="text-caption detail-pre">{{ detail.context?.instructions ?? '（脚本演示模式，无模型输入；见下方执行步骤）' }}</pre>
          <v-divider class="my-3" />

          <template v-if="detailRules.length > 0">
            <div class="text-caption font-weight-medium text-medium-emphasis mb-1">选用规则</div>
            <v-chip v-for="r in detailRules" :key="r" size="x-small" variant="outlined" class="mr-1 mb-1">
              {{ r }}
            </v-chip>
            <v-divider class="my-3" />
          </template>

          <div class="text-caption font-weight-medium text-medium-emphasis mb-1">
            工具调用（{{ detail.toolCalls.length }}）
          </div>
          <v-table density="compact">
            <thead>
              <tr>
                <th class="text-left text-caption">工具</th>
                <th class="text-center text-caption">状态</th>
                <th class="text-right text-caption">耗时</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="c in detail.toolCalls" :key="c.id">
                <td class="text-body-2">{{ c.name }}</td>
                <td class="text-center">
                  <v-icon size="14" :color="c.ok ? 'success' : 'error'">
                    {{ c.ok ? 'mdi-check' : 'mdi-close' }}
                  </v-icon>
                </td>
                <td class="text-right text-caption tabular-nums">{{ c.elapsedMs }}ms</td>
              </tr>
            </tbody>
          </v-table>

          <template v-if="detail.steps.length > 0">
            <v-divider class="my-3" />
            <div class="text-caption font-weight-medium text-medium-emphasis mb-1">
              执行流水（{{ detail.steps.length }}）
              <span v-if="detail.stepsTruncated" class="text-warning">· ⚠️ step 数超上限，部分被截断</span>
            </div>
            <div class="d-flex flex-column ga-1">
              <div
                v-for="s in detail.steps"
                :key="s.index"
                class="d-flex align-center justify-space-between pa-1 px-2 text-caption"
                style="border: 1px solid rgba(var(--v-border-color), 0.08); border-radius: 6px"
              >
                <span class="tabular-nums font-weight-medium">{{ s.kind }}</span>
                <span class="text-disabled tabular-nums">
                  +{{ s.sinceStartMs ?? 0 }}ms · 本步 {{ s.elapsedMs }}ms
                </span>
              </div>
            </div>
          </template>
          <v-divider class="my-3" />

          <template v-if="detail.provenance.length > 0">
            <div class="text-caption font-weight-medium text-medium-emphasis mb-1">数字溯源</div>
            <div class="d-flex flex-wrap ga-1">
              <v-chip
                v-for="(p, i) in detail.provenance"
                :key="i"
                size="x-small"
                :color="p.ok ? 'success' : 'error'"
                variant="tonal"
                class="tabular-nums"
              >
                {{ p.literal }} ← {{ p.source }}
              </v-chip>
            </div>
          </template>
        </template>

        <v-skeleton-loader v-else type="paragraph, table, paragraphs" />
      </div>
    </v-navigation-drawer>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import {
  fetchTraceDetail,
  listTraces,
  type TraceDetailDto,
  type TraceSummary,
} from '@/api/harness';
import { useToastStore } from '@/stores/toast';

const toast = useToastStore();
const runs = ref<TraceSummary[]>([]);
const drawerOpen = ref(false);
const detail = ref<TraceDetailDto | null>(null);
const detailRules = ref<string[]>([]);

onMounted(refresh);

async function refresh(): Promise<void> {
  try {
    runs.value = await listTraces(30);
  } catch (err) {
    toast.error('加载运行记录失败：' + (err instanceof Error ? err.message : String(err)));
  }
}

async function openDetail(runId: string): Promise<void> {
  drawerOpen.value = true;
  detail.value = null;
  try {
    const t = await fetchTraceDetail(runId);
    detail.value = t;
    detailRules.value = (t.context?.rules ?? []).map((r) => `${r.code} v${r.version}`);
  } catch (err) {
    toast.error('加载详情失败：' + (err instanceof Error ? err.message : String(err)));
    drawerOpen.value = false;
  }
}

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString('zh-CN', { hour12: false });
  } catch {
    return iso;
  }
}
</script>

<style scoped>
.min-width-0 {
  min-width: 0;
}
.detail-pre {
  max-height: 260px;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-all;
  font-family: var(--font-num);
  background-color: rgba(var(--v-theme-on-surface), 0.04);
  border-radius: 8px;
  padding: 10px;
}
</style>
