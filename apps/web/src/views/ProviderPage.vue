<template>
  <div class="pa-4">
    <!-- 头部信息 -->
    <div class="d-flex align-center justify-space-between mb-4 flex-wrap ga-2">
      <div>
        <h2 class="text-h6 font-weight-bold d-flex align-center ga-2">
          <v-icon color="primary" size="24">mdi-chip</v-icon>
          大模型服务商配置 (Provider)
        </h2>
        <div class="text-caption text-medium-emphasis mt-1">
          4 协议统一接入 44+ 厂商大模型（OpenAI Chat / OpenAI Responses / Anthropic / Gemini），支持多模式动态路由与工具调用。
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
          刷新配置
        </v-btn>
      </div>
    </div>

    <!-- 1. 当前生效模型状态卡片 -->
    <v-card variant="outlined" class="mb-4" style="border-radius: 12px">
      <div class="pa-4">
        <div class="d-flex align-center justify-space-between flex-wrap ga-3">
          <div class="d-flex align-center ga-3">
            <v-avatar size="44" :color="currentConfig.configured ? 'success' : 'warning'" variant="tonal">
              <v-icon size="24">{{ currentConfig.configured ? 'mdi-check-decagram' : 'mdi-alert-circle-outline' }}</v-icon>
            </v-avatar>
            <div>
              <div class="d-flex align-center ga-2">
                <span class="text-subtitle-1 font-weight-bold">
                  {{ currentConfig.configured ? currentConfig.model : '模型未配置 · 演示模式' }}
                </span>
                <v-chip
                  size="x-small"
                  :color="currentConfig.configured ? 'success' : 'warning'"
                  variant="flat"
                >
                  {{ currentConfig.configured ? '在线运行中' : '离线脚本驱动' }}
                </v-chip>
              </div>
              <div class="text-caption text-medium-emphasis mt-1">
                厂商：{{ currentConfig.vendor || '无' }} · Base URL：{{ currentConfig.baseUrl || '使用系统默认' }}
              </div>
            </div>
          </div>

          <div class="d-flex align-center ga-2">
            <v-chip size="small" variant="outlined" class="tabular-nums">
              已注册厂商：{{ vendors.length }} 家
            </v-chip>
            <v-chip size="small" variant="outlined" color="primary" class="tabular-nums">
              支持协议：4 套 (全兼容)
            </v-chip>
          </div>
        </div>
      </div>
    </v-card>

    <v-row>
      <!-- 2. 厂商预设快速配置与测试 -->
      <v-col cols="12" md="7">
        <v-card variant="outlined" class="fill-height" style="border-radius: 12px">
          <v-card-item>
            <v-card-title class="text-subtitle-1 font-weight-bold d-flex align-center ga-2">
              <v-icon size="20" color="primary">mdi-tune-variant</v-icon>
              连通性测试与参数调试
            </v-card-title>
            <v-card-subtitle class="text-caption">
              选择预设厂商，填入 API Key 即可实时发起连通性验证。
            </v-card-subtitle>
          </v-card-item>
          <v-divider />

          <div class="pa-4">
            <v-form @submit.prevent="runTest">
              <!-- 厂商选择器 -->
              <v-autocomplete
                v-model="form.vendor"
                :items="vendorOptions"
                item-title="label"
                item-value="id"
                label="快速选择厂商预设 (44+ 厂商)"
                density="compact"
                variant="outlined"
                class="mb-3"
                clearable
                @update:model-value="onVendorSelect"
              >
                <template #item="{ props: itemProps, item }">
                  <v-list-item v-bind="itemProps">
                    <template #append>
                      <v-chip size="x-small" variant="tonal" class="ml-2 font-mono">
                        {{ item.raw.protocol }}
                      </v-chip>
                    </template>
                  </v-list-item>
                </template>
              </v-autocomplete>

              <v-row dense>
                <v-col cols="12" sm="6">
                  <!-- 协议类型 -->
                  <v-select
                    v-model="form.protocol"
                    :items="protocolOptions"
                    label="底层通信协议"
                    density="compact"
                    variant="outlined"
                    class="mb-3"
                  />
                </v-col>
                <v-col cols="12" sm="6">
                  <!-- 模型名称 -->
                  <v-text-field
                    v-model="form.model"
                    label="模型标识 (Model ID)"
                    placeholder="如 deepseek-chat, claude-3-5-sonnet-latest"
                    density="compact"
                    variant="outlined"
                    class="mb-3"
                  />
                </v-col>
              </v-row>

              <!-- Base URL -->
              <v-text-field
                v-model="form.baseUrl"
                label="API 端点 (Base URL)"
                placeholder="https://api.deepseek.com/v1"
                density="compact"
                variant="outlined"
                class="mb-3 font-mono"
              />

              <!-- API Key -->
              <v-text-field
                v-model="form.apiKey"
                label="API 密钥 (API Key)"
                type="password"
                placeholder="sk-••••••••••••••••"
                density="compact"
                variant="outlined"
                class="mb-3"
                hint="仅在内存中进行连通性测试，不持久化存储到磁盘"
                persistent-hint
              />

              <div class="d-flex align-center justify-space-between mt-4">
                <v-btn
                  color="primary"
                  type="submit"
                  prepend-icon="mdi-lightning-bolt"
                  :loading="testing"
                  :disabled="!form.apiKey"
                >
                  发起连通性验证
                </v-btn>
                <span v-if="testResult" class="text-caption" :class="testResult.ok ? 'text-success' : 'text-error'">
                  <v-icon size="14" :color="testResult.ok ? 'success' : 'error'">
                    {{ testResult.ok ? 'mdi-check-circle' : 'mdi-close-circle' }}
                  </v-icon>
                  {{ testResult.message }} ({{ testResult.latencyMs }}ms)
                </span>
              </div>
            </v-form>
          </div>
        </v-card>
      </v-col>

      <!-- 3. 四大协议规范与环境配置看板 -->
      <v-col cols="12" md="5">
        <v-card variant="outlined" class="fill-height d-flex flex-column" style="border-radius: 12px">
          <v-card-item>
            <v-card-title class="text-subtitle-1 font-weight-bold d-flex align-center ga-2">
              <v-icon size="20" color="primary">mdi-code-braces</v-icon>
              协议架构与环境变量指引
            </v-card-title>
          </v-card-item>
          <v-divider />

          <div class="pa-4 flex-fill">
            <div class="text-caption font-weight-bold text-medium-emphasis mb-2">四套核心协议适配矩阵</div>
            <v-table density="compact" class="mb-4">
              <thead>
                <tr>
                  <th class="text-left text-caption">协议</th>
                  <th class="text-left text-caption">支持厂商</th>
                  <th class="text-left text-caption">调用规范</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td class="font-mono text-caption">openai-chat</td>
                  <td class="text-caption">38+ (DeepSeek, 阿里等)</td>
                  <td class="text-caption">/v1/chat/completions</td>
                </tr>
                <tr>
                  <td class="font-mono text-caption">openai-responses</td>
                  <td class="text-caption">OpenAI 原生</td>
                  <td class="text-caption">/v1/responses</td>
                </tr>
                <tr>
                  <td class="font-mono text-caption">anthropic</td>
                  <td class="text-caption">Anthropic Claude</td>
                  <td class="text-caption">/v1/messages</td>
                </tr>
                <tr>
                  <td class="font-mono text-caption">gemini</td>
                  <td class="text-caption">Google Gemini</td>
                  <td class="text-caption">generateContent</td>
                </tr>
              </tbody>
            </v-table>

            <div class="text-caption font-weight-bold text-medium-emphasis mb-2">服务端环境变量部署配置</div>
            <div class="bg-surface-variant pa-3 rounded-lg font-mono text-caption text-medium-emphasis" style="line-height: 1.6; word-break: break-all">
              # 启动前在 .env 或环境变量中设置：<br />
              HARNESS_LLM_VENDOR=deepseek<br />
              HARNESS_LLM_API_KEY=sk-xxxxxx<br />
              HARNESS_LLM_BASE_URL=https://api.deepseek.com/v1<br />
              HARNESS_LLM_MODEL=deepseek-chat
            </div>
          </div>
        </v-card>
      </v-col>
    </v-row>

    <!-- 4. 44 厂商预设总览表 -->
    <v-card variant="outlined" class="mt-4" style="border-radius: 12px">
      <v-card-item>
        <div class="d-flex align-center justify-space-between flex-wrap ga-2">
          <v-card-title class="text-subtitle-1 font-weight-bold d-flex align-center ga-2">
            <v-icon size="20" color="primary">mdi-format-list-bulleted-type</v-icon>
            内置 44 厂商预设表 (自动补全 BaseURL 与默认模型)
          </v-card-title>
          <v-text-field
            v-model="search"
            prepend-inner-icon="mdi-magnify"
            label="搜索厂商或协议..."
            density="compact"
            variant="outlined"
            hide-details
            style="max-width: 260px"
          />
        </div>
      </v-card-item>
      <v-divider />

      <v-table density="compact" hover>
        <thead>
          <tr>
            <th class="text-left">厂商标识 (ID)</th>
            <th class="text-left">显示名称</th>
            <th class="text-left">底层协议</th>
            <th class="text-left">推荐默认模型</th>
            <th class="text-left">默认 Base URL</th>
            <th class="text-left">操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="v in filteredVendors" :key="v.id">
            <td class="font-mono text-caption font-weight-medium">{{ v.id }}</td>
            <td class="text-body-2">{{ v.label }}</td>
            <td>
              <v-chip size="x-small" variant="tonal" :color="protocolColor(v.protocol)">
                {{ v.protocol }}
              </v-chip>
            </td>
            <td class="font-mono text-caption text-medium-emphasis">{{ v.defaultModel || '—' }}</td>
            <td class="font-mono text-caption text-medium-emphasis text-truncate" style="max-width: 240px">
              {{ v.baseUrl }}
            </td>
            <td>
              <v-btn
                size="x-small"
                variant="text"
                color="primary"
                prepend-icon="mdi-content-copy"
                @click="applyPreset(v)"
              >
                应用预设
              </v-btn>
            </td>
          </tr>
        </tbody>
      </v-table>
    </v-card>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { fetchProviders, testProvider, type VendorPresetDto } from '@/api/harness';

const loading = ref(false);
const testing = ref(false);
const search = ref('');

const currentConfig = ref({
  configured: false,
  vendor: '',
  model: '',
  baseUrl: '',
});

const vendors = ref<VendorPresetDto[]>([]);

const form = ref({
  vendor: 'deepseek',
  protocol: 'openai-chat',
  model: 'deepseek-chat',
  baseUrl: 'https://api.deepseek.com/v1',
  apiKey: '',
});

const testResult = ref<{ ok: boolean; message: string; latencyMs: number } | null>(null);

const protocolOptions = [
  { title: 'OpenAI Chat (chat/completions)', value: 'openai-chat' },
  { title: 'OpenAI Responses (responses API)', value: 'openai-responses' },
  { title: 'Anthropic Messages API', value: 'anthropic' },
  { title: 'Google Gemini (generateContent)', value: 'gemini' },
];

const vendorOptions = computed(() =>
  vendors.value.map((v) => ({
    id: v.id,
    label: `${v.label} (${v.id})`,
    raw: v,
  })),
);

const filteredVendors = computed(() => {
  const q = search.value.trim().toLowerCase();
  if (!q) return vendors.value;
  return vendors.value.filter(
    (v) =>
      v.id.toLowerCase().includes(q) ||
      v.label.toLowerCase().includes(q) ||
      v.protocol.toLowerCase().includes(q) ||
      v.defaultModel.toLowerCase().includes(q),
  );
});

function protocolColor(p: string): string {
  switch (p) {
    case 'openai-chat':
      return 'primary';
    case 'openai-responses':
      return 'secondary';
    case 'anthropic':
      return 'warning';
    case 'gemini':
      return 'info';
    default:
      return 'grey';
  }
}

function onVendorSelect(vId: string | null) {
  if (!vId) return;
  const found = vendors.value.find((v) => v.id === vId);
  if (found) {
    applyPreset(found);
  }
}

function applyPreset(preset: VendorPresetDto) {
  form.value.vendor = preset.id;
  form.value.protocol = preset.protocol;
  form.value.baseUrl = preset.baseUrl;
  form.value.model = preset.defaultModel;
  testResult.value = null;
}

async function loadData() {
  loading.value = true;
  try {
    const res = await fetchProviders();
    currentConfig.value = res.current;
    vendors.value = res.vendors;
    // 如果有匹配当前配置的厂商，初始化表单
    const currentVendor = vendors.value.find((v) => v.id === res.current.vendor);
    if (currentVendor) {
      applyPreset(currentVendor);
    }
  } catch (err) {
    console.error('Failed to load providers:', err);
  } finally {
    loading.value = false;
  }
}

async function runTest() {
  if (!form.value.apiKey) return;
  testing.value = true;
  testResult.value = null;
  try {
    const res = await testProvider({
      vendor: form.value.vendor,
      protocol: form.value.protocol,
      baseUrl: form.value.baseUrl,
      apiKey: form.value.apiKey,
      model: form.value.model,
    });
    testResult.value = {
      ok: res.ok,
      message: res.message || (res.ok ? '连接成功' : '连接失败'),
      latencyMs: res.latencyMs,
    };
  } catch (err) {
    testResult.value = {
      ok: false,
      message: err instanceof Error ? err.message : String(err),
      latencyMs: 0,
    };
  } finally {
    testing.value = false;
  }
}

onMounted(() => {
  void loadData();
});
</script>
