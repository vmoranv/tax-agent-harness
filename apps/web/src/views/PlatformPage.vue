<template>
  <div class="pa-4">
    <!-- 头部信息 -->
    <div class="d-flex align-center justify-space-between mb-4 flex-wrap ga-2">
      <div>
        <h2 class="text-h6 font-weight-bold d-flex align-center ga-2">
          <component :is="Radio" :size="24" class="text-primary" />
          消息渠道与 IM 适配器 (Platform)
        </h2>
        <div class="text-caption text-medium-emphasis mt-1">
          基于统一消息来源 (UMO: Unified Message Origin) 架构，已内置 7 大即时通讯平台安全适配器，支持高防验签与防重放。
        </div>
      </div>
      <div class="d-flex align-center ga-2">
        <v-btn
          color="primary"
          variant="tonal"
          size="small"
          prepend-icon="mdi-refresh"
          :loading="loading"
          @click="loadData"
        >
          刷新状态
        </v-btn>
      </div>
    </div>

    <!-- 平台卡片网格 -->
    <v-row class="mb-4">
      <v-col
        v-for="p in platforms"
        :key="p.id"
        cols="12"
        sm="6"
        lg="4"
      >
        <v-card
          variant="outlined"
          class="fill-height d-flex flex-column clickable-row"
          style="border-radius: 12px; transition: all 0.2s ease"
          @click="openDetail(p)"
        >
          <div class="pa-4 flex-fill d-flex flex-column">
            <!-- 卡片头部 -->
            <div class="d-flex align-center justify-space-between mb-3">
              <div class="d-flex align-center ga-3">
                <v-avatar size="38" color="primary" variant="tonal">
                  <component :is="getPlatformLucideIcon(p.id)" :size="20" />
                </v-avatar>
                <div>
                  <div class="text-subtitle-2 font-weight-bold">{{ p.name }}</div>
                  <div class="text-caption text-medium-emphasis font-mono">{{ p.id }}</div>
                </div>
              </div>
              <v-chip
                size="x-small"
                :color="p.status === 'running' ? 'success' : 'grey'"
                variant="flat"
              >
                {{ p.status === 'running' ? '已接入运行' : '待配置密钥' }}
              </v-chip>
            </div>

            <!-- 说明与特性 -->
            <div class="text-caption text-medium-emphasis mb-3 line-clamp-2" style="min-height: 36px">
              {{ p.description }}
            </div>

            <!-- 特性 Chips -->
            <div class="d-flex flex-wrap ga-1 mb-3">
              <v-chip
                v-for="feat in p.features"
                :key="feat"
                size="x-small"
                variant="outlined"
                color="secondary"
              >
                {{ feat }}
              </v-chip>
            </div>

            <v-spacer />
            <v-divider class="my-2" />

            <!-- 底部安全与验签 -->
            <div class="d-flex align-center justify-space-between text-caption text-disabled">
              <span class="text-truncate mr-2 font-mono" style="max-width: 200px">
                {{ p.authType }}
              </span>
              <v-icon size="16" color="primary">mdi-chevron-right</v-icon>
            </div>
          </div>
        </v-card>
      </v-col>
    </v-row>

    <!-- 架构说明卡片 -->
    <v-card variant="outlined" style="border-radius: 12px">
      <v-card-item>
        <v-card-title class="text-subtitle-1 font-weight-bold d-flex align-center ga-2">
          <v-icon size="20" color="primary">mdi-shield-lock-outline</v-icon>
          财税 Agent Harness 多渠道安全通信规范
        </v-card-title>
      </v-card-item>
      <v-divider />
      <div class="pa-4">
        <v-row dense>
          <v-col cols="12" md="4">
            <div class="text-caption font-weight-bold mb-1">1. 统一 UMO 会话标识</div>
            <div class="text-caption text-medium-emphasis">
              统一消息来源定义为 <code class="bg-surface-variant px-1 rounded">platformId:platformType:sessionId</code>，将微信、飞书、钉钉、Telegram 的平台消息无缝桥接至用例层，自动隔离企业数据上下文。
            </div>
          </v-col>
          <v-col cols="12" md="4">
            <div class="text-caption font-weight-bold mb-1">2. 高安全级验签防时序攻击</div>
            <div class="text-caption text-medium-emphasis">
              所有 Webhook 验签均采用 Node 原生 <code class="bg-surface-variant px-1 rounded">crypto.timingSafeEqual</code> 严格恒定时间校验，涵盖 Ed25519、HMAC-SHA256 与 XML 签名，彻底封堵时序侧信道攻击。
            </div>
          </v-col>
          <v-col cols="12" md="4">
            <div class="text-caption font-weight-bold mb-1">3. 防重放与幂等处理</div>
            <div class="text-caption text-medium-emphasis">
              消息接入内置时间戳偏差窗口校验（默认 5 分钟），结合平台全局 <code class="bg-surface-variant px-1 rounded">messageId</code> 幂等去重表，保障并发写发票用途与报税任务执行的安全无二义。
            </div>
          </v-col>
        </v-row>
      </div>
    </v-card>

    <!-- 详情配置弹窗 -->
    <v-dialog v-model="detailDialog" max-width="640">
      <v-card v-if="selectedPlatform" style="border-radius: 14px">
        <v-card-item>
          <div class="d-flex align-center ga-3">
            <v-avatar size="36" color="primary" variant="tonal">
              <component :is="getPlatformLucideIcon(selectedPlatform.id)" :size="20" />
            </v-avatar>
            <div>
              <v-card-title class="text-subtitle-1 font-weight-bold">
                {{ selectedPlatform.name }} 适配配置指南
              </v-card-title>
              <v-card-subtitle class="text-caption font-mono">
                通道标识: {{ selectedPlatform.id }} · 通信机制: {{ selectedPlatform.type }}
              </v-card-subtitle>
            </div>
          </div>
        </v-card-item>
        <v-divider />

        <div class="pa-4">
          <!-- Webhook 地址 -->
          <div class="mb-4">
            <div class="text-caption font-weight-bold text-medium-emphasis mb-1">
              平台回调通知地址 (Webhook URL)
            </div>
            <div class="d-flex align-center ga-2">
              <v-text-field
                :model-value="getWebhookUrl(selectedPlatform.webhookPath)"
                density="compact"
                variant="outlined"
                readonly
                hide-details
                class="font-mono text-caption"
              />
              <v-btn
                variant="tonal"
                color="primary"
                size="small"
                @click="copyUrl(getWebhookUrl(selectedPlatform.webhookPath))"
              >
                复制
              </v-btn>
            </div>
            <div class="text-caption text-disabled mt-1">
              在 {{ selectedPlatform.name }} 开发者后台将事件订阅请求地址指向该 URL。
            </div>
          </div>

          <!-- 验签说明 -->
          <div class="mb-4">
            <div class="text-caption font-weight-bold text-medium-emphasis mb-1">
              安全验签机制
            </div>
            <v-sheet class="pa-3 rounded-lg bg-surface-variant font-mono text-caption">
              {{ selectedPlatform.authType }}
            </v-sheet>
          </div>

          <!-- 所需配置项 -->
          <div class="mb-3">
            <div class="text-caption font-weight-bold text-medium-emphasis mb-2">
              环境变量配置项 (注入服务端启动)
            </div>
            <v-table density="compact" class="border rounded-lg">
              <thead>
                <tr>
                  <th class="text-left text-caption">参数名称</th>
                  <th class="text-left text-caption">必填</th>
                  <th class="text-left text-caption">示例/说明</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="field in selectedPlatform.configFields" :key="field.key">
                  <td class="font-mono text-caption font-weight-medium">{{ field.key }}</td>
                  <td>
                    <v-chip size="x-small" :color="field.required ? 'error' : 'grey'" variant="tonal">
                      {{ field.required ? '必填' : '选填' }}
                    </v-chip>
                  </td>
                  <td class="text-caption text-medium-emphasis font-mono">
                    {{ field.placeholder || (field.secret ? '••••••••' : field.label) }}
                  </td>
                </tr>
              </tbody>
            </v-table>
          </div>
        </div>

        <v-divider />
        <v-card-actions class="pa-3">
          <v-spacer />
          <v-btn variant="text" color="primary" @click="detailDialog = false">关闭</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <!-- 复制成功提示 -->
    <v-snackbar v-model="copiedSnackbar" timeout="2000" color="success" rounded="lg">
      <v-icon size="16" class="mr-2">mdi-check</v-icon>
      Webhook 地址已复制到剪贴板
    </v-snackbar>
  </div>
</template>

<script setup lang="ts">
import { Bot, Feather, Globe, Hash, MessageSquare, MessagesSquare, Radio, Send } from '@lucide/vue';
import { onMounted, ref } from 'vue';
import { fetchPlatforms, type PlatformDto } from '@/api/harness';

const loading = ref(false);
const platforms = ref<PlatformDto[]>([]);
const detailDialog = ref(false);
const selectedPlatform = ref<PlatformDto | null>(null);
const copiedSnackbar = ref(false);

function getPlatformLucideIcon(id: string) {
  switch (id) {
    case 'lark':
      return Feather;
    case 'dingtalk':
      return Radio;
    case 'wecom':
      return MessagesSquare;
    case 'qqofficial':
      return Bot;
    case 'telegram':
      return Send;
    case 'discord':
      return Hash;
    case 'slack':
      return Globe;
    default:
      return MessageSquare;
  }
}

function getWebhookUrl(path: string): string {
  const origin = window.location.origin;
  return `${origin}${path}`;
}

function openDetail(p: PlatformDto) {
  selectedPlatform.value = p;
  detailDialog.value = true;
}

async function copyUrl(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    copiedSnackbar.value = true;
  } catch {
    window.prompt('请手动复制 Webhook URL:', text);
  }
}

async function loadData() {
  loading.value = true;
  try {
    const res = await fetchPlatforms();
    platforms.value = res.platforms;
  } catch (err) {
    console.error('Failed to load platforms:', err);
  } finally {
    loading.value = false;
  }
}

onMounted(() => {
  void loadData();
});
</script>

<style scoped>
.clickable-row {
  cursor: pointer;
}
.clickable-row:hover {
  border-color: rgba(var(--v-theme-primary), 0.5) !important;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.06);
}
</style>
