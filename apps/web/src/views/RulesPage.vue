<template>
  <div class="pa-4">
    <!-- 过滤 chips（隐形引导：状态一眼可辨） -->
    <div class="d-flex align-center ga-2 mb-3">
      <v-chip
        v-for="f in filters"
        :key="f.value"
        size="small"
        :variant="activeFilter === f.value ? 'tonal' : 'outlined'"
        :color="f.color"
        class="clickable-row"
        @click="activeFilter = f.value"
      >
        {{ f.label }} · {{ countBy(f.value) }}
      </v-chip>
      <v-spacer />
      <span class="text-caption text-medium-emphasis">共 {{ rules.length }} 条 · 状态由 CLI 管理</span>
    </div>

    <v-card variant="outlined" style="border-radius: 12px">
      <v-table density="comfortable">
        <thead>
          <tr>
            <th class="text-left">编号</th>
            <th class="text-left">名称</th>
            <th class="text-left">适用范围</th>
            <th class="text-left">生效日期</th>
            <th class="text-left">用途要求</th>
            <th class="text-right">状态</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="r in filtered"
            :key="r.code + r.version"
            class="clickable-row"
            @click="expanded = expanded === r.code + r.version ? null : r.code + r.version"
          >
            <td class="tabular-nums text-body-2">{{ r.code }} v{{ r.version }}</td>
            <td class="text-body-2">{{ r.title }}</td>
            <td class="text-body-2 text-medium-emphasis">{{ r.scope }}</td>
            <td class="text-body-2 tabular-nums">{{ r.effective_from }}</td>
            <td class="text-body-2 text-medium-emphasis">
              {{ r.obligation?.summary ?? '—' }}
            </td>
            <td class="text-right">
              <v-chip size="x-small" :color="r.status === 'enabled' ? 'success' : 'grey'" variant="tonal">
                {{ r.status === 'enabled' ? '启用' : '已停用' }}
              </v-chip>
            </td>
          </tr>
        </tbody>
      </v-table>

      <!-- 正文展开 -->
      <v-expand-transition>
        <div v-if="expandedRule !== null" class="pa-4" style="background-color: rgba(var(--v-theme-on-surface), 0.03)">
          <div class="text-subtitle-2 mb-2">
            {{ expandedRule.code }}《{{ expandedRule.title }}》 v{{ expandedRule.version }} · 正文
          </div>
          <div class="text-body-2" style="white-space: pre-wrap; line-height: 1.8">{{ expandedRule.body }}</div>
        </div>
      </v-expand-transition>
    </v-card>

    <v-alert type="info" variant="tonal" density="compact" class="mt-3 text-caption">
      规则由程序按「企业 + 期间 + 状态」三重过滤后选用，同一编号取生效日期最新的启用版本。
      检查 2026-09 用途：甲企业 → R002 v2.0（每张必填）；乙企业 → R003（≥1000.00 元必填）。
      增删改规则走 CLI：<code>harness rule import / disable / enable</code>。
    </v-alert>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { fetchRules, type RuleMeta } from '@/api/harness';
import { useSessionStore } from '@/stores/session';
import { useToastStore } from '@/stores/toast';

const session = useSessionStore();
const toast = useToastStore();

const rules = ref<RuleMeta[]>([]);
const expanded = ref<string | null>(null);
const activeFilter = ref<string>('all');

const filters = [
  { value: 'all', label: '全部', color: 'primary' },
  { value: 'enabled', label: '启用', color: 'success' },
  { value: 'disabled', label: '已停用', color: 'grey' },
];

const filtered = computed(() =>
  activeFilter.value === 'all'
    ? rules.value
    : rules.value.filter((r) => r.status === activeFilter.value),
);

const expandedRule = computed(() =>
  expanded.value === null
    ? null
    : (rules.value.find((r) => r.code + r.version === expanded.value) ?? null),
);

function countBy(status: string): number {
  return status === 'all'
    ? rules.value.length
    : rules.value.filter((r) => r.status === status).length;
}

onMounted(async () => {
  try {
    // bootstrapMeta 已拉过规则；store 是唯一数据源
    if (session.rules.length === 0) await session.bootstrapMeta();
    rules.value = session.rules;
  } catch (err) {
    toast.error('加载规则失败：' + (err instanceof Error ? err.message : String(err)));
  }
});
</script>
