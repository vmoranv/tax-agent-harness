<template>
  <v-app-bar
    density="compact"
    elevation="0"
    class="harness-header"
    style="border-bottom: 1px solid rgba(var(--v-border-color), var(--v-border-opacity))"
  >
    <!-- 面包屑式页面标题 -->
    <v-icon size="16" class="ml-3 mr-1 text-medium-emphasis">{{ routeIcon }}</v-icon>
    <span class="text-body-2 text-medium-emphasis">{{ title }}</span>

    <v-spacer />

    <!-- 模型状态（隐形引导：绿点=可用，红点=未配置，悬停有说明） -->
    <v-tooltip location="bottom" open-delay="300">
      <template #activator="{ props }">
        <div v-bind="props" class="d-flex align-center mr-4 cursor-default">
          <span class="status-dot mr-2" :style="{ backgroundColor: llmColor }" />
          <span class="text-caption text-medium-emphasis">{{ llmLabel }}</span>
        </div>
      </template>
      {{ llmTooltip }}
    </v-tooltip>

    <!-- 主题三态 -->
    <v-btn icon size="small" variant="text" aria-label="切换主题" @click="cycleTheme">
      <v-icon size="20">{{ themeIcon }}</v-icon>
      <v-tooltip location="bottom" open-delay="300" activator="parent">
        主题：{{ themeModeLabel }}（点击切换）
      </v-tooltip>
    </v-btn>

    <!-- 用户身份菜单 -->
    <v-menu location="bottom end" transition="fade-transition">
      <template #activator="{ props }">
        <v-btn v-bind="props" icon size="small" variant="text" class="mr-2" aria-label="当前用户">
          <v-avatar size="28" color="primary" variant="tonal">
            <span class="text-caption font-weight-medium">{{ userInitial }}</span>
          </v-avatar>
        </v-btn>
      </template>
      <v-card min-width="260" elevation="4">
        <v-list density="compact">
          <v-list-item>
            <v-list-item-title class="text-body-2 font-weight-medium">
              {{ userLabel }}
            </v-list-item-title>
            <v-list-item-subtitle class="text-caption">{{ userId }}</v-list-item-subtitle>
          </v-list-item>
          <v-divider class="my-1" />
          <v-list-item
            v-for="g in userGrants"
            :key="g.enterpriseId"
            density="compact"
          >
            <template #prepend>
              <v-icon size="16" :color="grantColor(g.level)">
                {{ grantIcon(g.level) }}
              </v-icon>
            </template>
            <v-list-item-title class="text-body-2">{{ g.enterpriseName }}</v-list-item-title>
            <template #append>
              <span class="text-caption text-medium-emphasis">{{ grantLabel(g.level) }}</span>
            </template>
          </v-list-item>
          <v-divider class="my-1" />
          <v-list-item density="compact">
            <v-list-item-subtitle class="text-caption">
              身份由页面选择传入，权限由后端用例层判定——对话中无法提升权限。
            </v-list-item-subtitle>
          </v-list-item>
        </v-list>
      </v-card>
    </v-menu>
  </v-app-bar>
</template>

<script setup lang="ts">
// 顶栏（完整版）：页面标题 + 模型状态 + 主题 + 用户权限菜单。
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import { useCustomizerStore } from '@/stores/customizer';
import { useSessionStore } from '@/stores/session';

const route = useRoute();
const customizer = useCustomizerStore();
const session = useSessionStore();

const title = computed(() => (route.meta?.title as string | undefined) ?? '财税 Agent Harness');
const routeIcon = computed(
  () => (route.meta?.icon as string | undefined) ?? 'mdi-view-dashboard-outline',
);

/* ---------- 模型状态 ---------- */
const llmColor = computed(() => (session.llmConfigured ? 'success' : 'warning'));
const llmLabel = computed(() =>
  session.llmConfigured ? session.llmModel : '模型未配置 · 演示模式',
);
const llmTooltip = computed(() =>
  session.llmConfigured
    ? `在线模型：${session.llmModel}（${session.llmVendor}）`
    : '未配置 HARNESS_LLM_* 环境变量。演示模式用脚本驱动真实工具；配置后可在对话页切换在线模式。',
);

/* ---------- 主题 ---------- */
const themeIcon = computed(() =>
  customizer.uiTheme === 'PurpleThemeDark' ? 'mdi-weather-night' : 'mdi-weather-sunny',
);
const themeModeLabel = computed(
  () => ({ light: '浅色', dark: '深色', system: '跟随系统' })[customizer.themeMode] ?? '浅色',
);

function cycleTheme(): void {
  const next =
    customizer.themeMode === 'light'
      ? 'dark'
      : customizer.themeMode === 'dark'
        ? 'system'
        : 'light';
  customizer.themeMode = next;
  if (next !== 'system') {
    const uiTheme = next === 'dark' ? 'PurpleThemeDark' : 'PurpleTheme';
    customizer.uiTheme = uiTheme;
    localStorage.setItem('uiTheme', uiTheme);
    void import('@/plugins/vuetify').then(({ default: vuetify }) => {
      vuetify.theme.global.name.value = uiTheme;
    });
  }
}

/* ---------- 用户 ---------- */
const userLabel = computed(() => session.userDisplayName ?? session.userId ?? '未选择');
const userInitial = computed(() => (session.userId ?? '?').slice(-1));

const userGrants = computed(() =>
  session.userGrants.map((g) => ({ ...g, enterpriseName: session.enterpriseName(g.enterpriseId) })),
);

function grantIcon(level: string): string {
  return level === 'read-write' ? 'mdi-pencil' : level === 'read-only' ? 'mdi-eye' : 'mdi-block';
}
function grantColor(level: string): string {
  return level === 'read-write' ? 'success' : level === 'read-only' ? 'info' : 'grey';
}
function grantLabel(level: string): string {
  return level === 'read-write' ? '可读写' : level === 'read-only' ? '只读' : '无权访问';
}
</script>
