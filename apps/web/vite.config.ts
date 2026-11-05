import vue from '@vitejs/plugin-vue';
import { fileURLToPath, URL } from 'url';
import { defineConfig } from 'vite';
import vuetify from 'vite-plugin-vuetify';

// 财税 Harness WebUI
// 改动：移除 webfont 下载 / MDI 子集化 / t2i 静态资源（离线可构建）；
// 代理 /api → 本地 Fastify（apps/api，端口 9601）。
export default defineConfig(() => ({
  plugins: [
    vue({
      template: {
        compilerOptions: {
          isCustomElement: (tag) => ['v-list-recognize-title'].includes(tag),
        },
      },
    }),
    vuetify({ autoImport: true }),
  ],
  resolve: {
    alias: [
      {
        find: /^shiki$/,
        replacement: fileURLToPath(new URL('./src/utils/shikiLimitedBundle.js', import.meta.url)),
      },
      {
        find: /^stream-monaco$/,
        replacement: fileURLToPath(new URL('./src/utils/streamMonacoDisabled.js', import.meta.url)),
      },
      {
        find: '@',
        replacement: fileURLToPath(new URL('./src', import.meta.url)),
      },
    ],
  },
  css: {
    preprocessorOptions: {
      scss: {},
    },
  },
  build: {
    sourcemap: false,
    chunkSizeWarningLimit: 2048,
  },
  optimizeDeps: {
    exclude: ['vuetify'],
    entries: ['./src/**/*.vue'],
  },
  server: {
    host: '0.0.0.0',
    port: 9602,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:9601/',
        changeOrigin: true,
        ws: true,
      },
    },
  },
}));
