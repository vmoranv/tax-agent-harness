<template>
  <!-- 路由切换动画：淡入 + 轻微上移 -->
  <RouterView v-slot="{ Component }">
    <Transition name="route-fade" mode="out-in">
      <component :is="Component" />
    </Transition>
  </RouterView>

  <!-- 全局唯一 snackbar（保留自原骨架） -->
  <v-snackbar
    v-if="toastStore.current"
    v-model="snackbarShow"
    :color="toastStore.current.color"
    :timeout="toastStore.current.timeout"
    :multi-line="toastStore.current.multiLine"
    :location="toastStore.current.location"
    close-on-back
  >
    <div class="app-snackbar-message">
      <v-icon v-if="toastIcon" :icon="toastIcon" size="24" />
      <span>{{ toastStore.current.message }}</span>
    </div>
    <template #actions v-if="toastStore.current.closable">
      <v-btn
        icon="mdi-close"
        variant="text"
        size="small"
        aria-label="Close notification"
        @click="snackbarShow = false"
      />
    </template>
  </v-snackbar>
</template>

<script setup>
import { computed } from 'vue';
import { RouterView } from 'vue-router';
import { useToastStore } from '@/stores/toast';

const toastStore = useToastStore();

const snackbarShow = computed({
  get: () => !!toastStore.current,
  set: (val) => {
    if (!val) toastStore.shift();
  },
});

const toastIcon = computed(
  () =>
    ({
      success: 'mdi-check-circle-outline',
      error: 'mdi-alert-circle-outline',
      warning: 'mdi-alert-outline',
      info: 'mdi-information-outline',
      primary: 'mdi-information-outline',
    })[toastStore.current?.color] || '',
);
</script>

<style>
/* 路由切换动画 */
.route-fade-enter-active,
.route-fade-leave-active {
  transition: opacity 0.18s ease, transform 0.18s ease;
}
.route-fade-enter-from {
  opacity: 0;
  transform: translateY(6px);
}
.route-fade-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}
</style>
