<template>
  <v-navigation-drawer
    :model-value="!isMobile || mobileDrawer.open"
    :temporary="isMobile"
    :permanent="!isMobile"
    :rail="collapsed"
    :width="232"
    :rail-width="60"
    location="left"
    style="border-right: 1px solid rgba(var(--v-border-color), var(--v-border-opacity))"
  >
    <!-- 品牌区：点击折叠 -->
    <div
      class="pa-4 d-flex align-center ga-2 clickable-row"
      style="height: 56px"
      @click="collapsed = !collapsed"
    >
      <v-icon icon="mdi-file-document-edit-outline" color="primary" />
      <span v-if="!collapsed" class="text-subtitle-1 font-weight-medium">财税 Harness</span>
    </div>
    <v-divider />

    <v-list density="compact" nav class="px-2">
      <template v-for="section in sections" :key="section.header">
        <v-list-subheader v-if="!collapsed" class="text-caption text-uppercase">
          {{ section.header }}
        </v-list-subheader>
        <NavItem
          v-for="item in section.items"
          :key="item.to"
          :item="{ ...item, header: section.header }"
          :collapsed="collapsed"
        />
      </template>
    </v-list>

    <template #append>
      <div v-if="!collapsed" class="pa-4 text-caption text-medium-emphasis">
        <div>SQLite · 单机演示</div>
        <div class="mt-1">TypeScript · Vue · Fastify</div>
      </div>
    </template>
  </v-navigation-drawer>
</template>

<script setup lang="ts">
// 侧边栏（完整版）：分组导航 + 计数徽标 + 可折叠。
import { computed, onMounted, ref } from 'vue';
import { useDisplay } from 'vuetify';
import { useMobileDrawerStore } from '@/stores/mobileDrawer';
import { useSessionStore } from '@/stores/session';
import NavItem from './NavItem.vue';
import sidebarItem from './sidebarItem';

const { mobile } = useDisplay();
const mobileDrawer = useMobileDrawerStore();
const session = useSessionStore();

const collapsed = ref(false);
const isMobile = computed(() => mobile.value);

/** 分组导航：工作台 / 集成与模型 / 规则与审计 / 监控与数据。 */
const sections = computed(() => [
  {
    header: '工作台',
    items: sidebarItem.filter((i) => i.to === '/'),
  },
  {
    header: '集成与模型',
    items: sidebarItem.filter((i) => i.to === '/providers' || i.to === '/platforms'),
  },
  {
    header: '规则与审计',
    items: sidebarItem.filter((i) => i.to === '/rules' || i.to === '/traces'),
  },
  {
    header: '监控与数据',
    items: sidebarItem.filter((i) => i.to === '/console' || i.to === '/eval' || i.to === '/data'),
  },
]);

const ruleCount = computed(() => session.ruleCount);
const traceCount = computed(() => session.traceCount);

onMounted(() => {
  void session.refreshCounts();
});
</script>
