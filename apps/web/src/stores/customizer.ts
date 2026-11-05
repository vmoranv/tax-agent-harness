import { defineStore } from 'pinia';

export type ThemeMode = 'light' | 'dark' | 'system';

export function resolveUiTheme(mode: ThemeMode): string {
  if (mode === 'dark') return 'PurpleThemeDark';
  if (mode === 'light') return 'PurpleTheme';
  if (typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches) {
    return 'PurpleThemeDark';
  }
  return 'PurpleTheme';
}

const savedMode =
  (typeof localStorage !== 'undefined' && (localStorage.getItem('themeMode') as ThemeMode)) ||
  'light';
const savedTheme =
  (typeof localStorage !== 'undefined' && localStorage.getItem('uiTheme')) ||
  resolveUiTheme(savedMode);

const DARK_THEMES: ReadonlySet<string> = new Set(['PurpleThemeDark']);

export const useCustomizerStore = defineStore('customizer', {
  state: () => ({
    Sidebar_drawer: true,
    Customizer_drawer: false,
    mini_sidebar: false,
    fontTheme: 'Noto Sans SC',
    uiTheme: savedTheme,
    themeMode: savedMode,
    inputBg: false,
    chatSidebarOpen: false,
    chatSidebarCollapsed: false,
  }),

  getters: {
    isDark: (state) => (state.uiTheme ? DARK_THEMES.has(state.uiTheme) : false),
  },

  actions: {
    SET_SIDEBAR_DRAWER() {
      this.Sidebar_drawer = !this.Sidebar_drawer;
    },
    SET_MINI_SIDEBAR(payload: boolean) {
      this.mini_sidebar = payload;
    },
    SET_FONT(payload: string) {
      this.fontTheme = payload;
    },

    SET_UI_THEME(payload: string) {
      this.uiTheme = payload;
      localStorage.setItem('uiTheme', payload);
      const mode: ThemeMode = payload === 'PurpleThemeDark' ? 'dark' : 'light';
      this.themeMode = mode;
      localStorage.setItem('themeMode', mode);
    },

    SET_THEME_MODE(mode: ThemeMode) {
      this.themeMode = mode;
      localStorage.setItem('themeMode', mode);
      const uiTheme = resolveUiTheme(mode);
      this.uiTheme = uiTheme;
      localStorage.setItem('uiTheme', uiTheme);
    },

    TOGGLE_CHAT_SIDEBAR() {
      this.chatSidebarOpen = !this.chatSidebarOpen;
    },
    SET_CHAT_SIDEBAR(payload: boolean) {
      this.chatSidebarOpen = payload;
    },
    SET_CHAT_SIDEBAR_COLLAPSED(payload: boolean) {
      this.chatSidebarCollapsed = payload;
    },
  },
});
