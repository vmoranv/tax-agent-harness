import { createRouter, createWebHashHistory } from 'vue-router';
import { useRouterLoadingStore } from '@/stores/routerLoading';

/**
 * 路由：对话（工作台）/ 规则库 / 运行记录。
 * 无登录守卫——身份由页面显式选择，权限由后端用例层判定。
 */

const MainRoutes = {
  path: '/',
  component: () => import('@/layouts/full/FullLayout.vue'),
  children: [
    {
      name: 'Chat',
      path: '',
      component: () => import('@/views/ChatPage.vue'),
      meta: { title: '对话', icon: 'mdi-text-box-check-outline' },
    },
    {
      name: 'Rules',
      path: '/rules',
      component: () => import('@/views/RulesPage.vue'),
      meta: { title: '规则库', icon: 'mdi-file-document-outline' },
    },
    {
      name: 'Providers',
      path: '/providers',
      component: () => import('@/views/ProviderPage.vue'),
      meta: { title: '模型服务商', icon: 'mdi-chip' },
    },
    {
      name: 'Platforms',
      path: '/platforms',
      component: () => import('@/views/PlatformPage.vue'),
      meta: { title: '消息渠道', icon: 'mdi-message-badge-outline' },
    },
    {
      name: 'Traces',
      path: '/traces',
      component: () => import('@/views/TracesPage.vue'),
      meta: { title: '运行记录', icon: 'mdi-history' },
    },
    {
      name: 'Console',
      path: '/console',
      component: () => import('@/views/ConsolePage.vue'),
      meta: { title: '日志控制台', icon: 'mdi-console-line' },
    },
    {
      name: 'Eval',
      path: '/eval',
      component: () => import('@/views/EvalPage.vue'),
      meta: { title: '评测中台', icon: 'mdi-chart-box-outline' },
    },
    {
      name: 'Data',
      path: '/data',
      component: () => import('@/views/DataPage.vue'),
      meta: { title: '数据中台', icon: 'mdi-database-outline' },
    },
  ],
};

export const router = createRouter({
  history: createWebHashHistory(import.meta.env.BASE_URL),
  routes: [MainRoutes],
});

router.beforeEach((to, from, next) => {
  if (from.name && from.path !== to.path) {
    useRouterLoadingStore().start();
  }
  next();
});

router.afterEach(() => {
  useRouterLoadingStore().finish();
});
