<template>
  <v-dialog v-model="isOpen" max-width="400">
    <v-card>
      <v-card-title class="text-h3 pa-4 pb-0 pl-6">{{ title }}</v-card-title>
      <v-card-text>{{ message }}</v-card-text>
      <v-card-actions>
        <v-spacer></v-spacer>
        <v-btn color="gray" variant="text" @click="handleCancel">{{ '取消' }}</v-btn>
        <v-btn color="red" variant="tonal" @click="handleConfirm">{{ '确认' }}</v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<script setup>
import { ref } from 'vue';

const isOpen = ref(false);
const title = ref('');
const message = ref('');
let resolvePromise = null; // ✅ 确保 Promise 句柄可用

const open = (options) => {
  title.value = options.title || props.title || '确认操作';
  message.value = options.message || props.message || '确认执行此操作？';
  isOpen.value = true;

  return new Promise((resolve) => {
    resolvePromise = resolve; // ✅ 赋值 Promise 解析方法
  });
};

const handleConfirm = () => {
  isOpen.value = false;
  if (resolvePromise) resolvePromise(true); // ✅ 解析 Promise
};

const handleCancel = () => {
  isOpen.value = false;
  if (resolvePromise) resolvePromise(false); // ✅ 解析 Promise
};

defineExpose({ open }); // ✅ 确保 `confirmPlugin.ts` 可以访问 `open`
</script>
