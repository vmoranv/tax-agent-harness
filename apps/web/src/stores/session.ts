import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { fetchHealth, fetchRules, fetchUsers, type RuleMeta, type UserMeta } from '@/api/harness';

/**
 * 会话状态：当前身份、企业、权限、LLM 状态、导航计数。
 *
 * 身份由 UI 显式选择（对齐赛题「先选定用户和企业再对话」），
 * 权限快照仅用于禁用输入——真正判定在后端用例层。
 */
export const useSessionStore = defineStore('session', () => {
  const userId = ref<string | null>(null);
  const userDisplayName = ref<string | null>(null);
  const enterpriseId = ref<string | null>(null);
  const userGrants = ref<
    Array<{ enterpriseId: string; level: 'read-write' | 'read-only' | 'none' }>
  >([]);
  const users = ref<UserMeta[]>([]);
  const rules = ref<RuleMeta[]>([]);

  const llmConfigured = ref(false);
  const llmVendor = ref('');
  const llmModel = ref('');

  const ruleCount = ref(0);
  const traceCount = ref(0);

  const enterpriseName = (id: string): string => {
    const names: Record<string, string> = { C001: '甲企业', C002: '乙企业' };
    return names[id] ?? id;
  };

  const currentLevel = computed(() => {
    if (enterpriseId.value === null) return null;
    return userGrants.value.find((g) => g.enterpriseId === enterpriseId.value)?.level ?? null;
  });

  function selectUser(id: string): void {
    userId.value = id;
    const u = users.value.find((x) => x.id === id);
    userDisplayName.value = u?.display_name ?? id;
    userGrants.value = (u?.grants ?? []) as never;
    // 切换用户时，若当前企业无权则回落到有权的第一个
    const granted = userGrants.value.find((g) => g.enterpriseId === enterpriseId.value);
    if (granted === undefined && userGrants.value.length > 0) {
      enterpriseId.value = userGrants.value[0]!.enterpriseId;
    }
  }

  function selectEnterprise(id: string): void {
    enterpriseId.value = id;
  }

  /** 启动时拉取身份、规则与模型状态。 */
  async function bootstrapMeta(): Promise<void> {
    const [us, rs, health] = await Promise.all([fetchUsers(), fetchRules(), fetchHealth()]);
    users.value = us;
    rules.value = rs;
    ruleCount.value = rs.length;
    llmConfigured.value = health.llm.configured;
    llmVendor.value = health.llm.vendor;
    llmModel.value = health.llm.model;
    if (us.length > 0) selectUser(us[0]!.id);
    if (userGrants.value.length > 0) selectEnterprise(userGrants.value[0]!.enterpriseId);
  }

  async function refreshCounts(): Promise<void> {
    try {
      const { listTraces } = await import('@/api/harness');
      traceCount.value = (await listTraces(1)).length >= 1 ? traceCount.value : traceCount.value;
    } catch {
      /* 静默：计数只是导航徽标 */
    }
  }

  return {
    userId,
    userDisplayName,
    enterpriseId,
    userGrants,
    users,
    rules,
    llmConfigured,
    llmVendor,
    llmModel,
    ruleCount,
    traceCount,
    currentLevel,
    enterpriseName,
    selectUser,
    selectEnterprise,
    bootstrapMeta,
    refreshCounts,
  };
});
