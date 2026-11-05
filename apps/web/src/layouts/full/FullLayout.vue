<template>
  <v-app>
    <VerticalSidebarVue />
    <VerticalHeaderVue />
    <v-main class="app-main">
      <div class="page-container">
        <RouterView v-slot="{ Component }">
          <Transition name="route-fade">
            <component :is="Component" />
          </Transition>
        </RouterView>
      </div>
    </v-main>
  </v-app>
</template>

<script setup lang="ts">
// 财税 Harness 布局：左侧栏 + 顶栏 + 内容。
// 路由动画为「进入动画」—— 退出即时，可被快速导航打断。
import { RouterView } from 'vue-router';
import VerticalHeaderVue from './vertical-header/VerticalHeader.vue';
import VerticalSidebarVue from './vertical-sidebar/VerticalSidebar.vue';
</script>

<style scoped>
.app-main {
  height: 100vh;
  overflow: hidden;
}

.page-container {
  height: 100%;
  width: 100%;
  box-sizing: border-box;
  padding: 16px;
  overflow-y: auto;
}
</style>
