import { createPinia } from 'pinia';
import { createApp, watch } from 'vue';
import App from './App.vue';
import confirmPlugin from './plugins/confirmPlugin';
import vuetify from './plugins/vuetify';
import { router } from './router';
import '@/scss/style.scss';
import '@/styles/tokens.css';

/**
 * 主题同步：store 的 uiTheme ↔ Vuetify theme 一致；
 * system 模式监听系统偏好；应用自定义主色。裁自参考骨架。
 */
function setupThemeSync(pinia: ReturnType<typeof createPinia>) {
  import('./stores/customizer').then(({ useCustomizerStore }) => {
    const customizer = useCustomizerStore(pinia);

    if (customizer.themeMode === 'system') {
      const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      customizer.uiTheme = prefersDark ? 'PurpleThemeDark' : 'PurpleTheme';
      localStorage.setItem('uiTheme', customizer.uiTheme);
    }

    vuetify.theme.global.name.value = customizer.uiTheme;

    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    mediaQuery.addEventListener('change', (e) => {
      if (customizer.themeMode !== 'system') return;
      customizer.uiTheme = e.matches ? 'PurpleThemeDark' : 'PurpleTheme';
      localStorage.setItem('uiTheme', customizer.uiTheme);
      vuetify.theme.global.name.value = customizer.uiTheme;
    });
  });
}

const app = createApp(App);
const pinia = createPinia();
app.use(pinia);
app.use(router);
app.use(vuetify);
app.use(confirmPlugin);
void router.isReady().then(() => app.mount('#app'));
setupThemeSync(pinia);
