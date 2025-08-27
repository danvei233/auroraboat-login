import { fileURLToPath, URL } from 'node:url'
import Components from 'unplugin-vue-components/vite';
import { AntDesignVueResolver } from 'unplugin-vue-components/resolvers';
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import vueDevTools from 'vite-plugin-vue-devtools'

// https://vite.dev/config/
export default defineConfig(({ command, mode })=>{
    const base =
        mode=== 'production'
            ? process.env.VITE_ASSET_BASE || '/static/component/auroraboat/login/'
            : '/'

   return {
    base,
  plugins: [
    vue(),
    vueDevTools(),
      Components({
          resolvers: [
              AntDesignVueResolver({
                  importStyle: false, // css in js
              }),
          ],
      }),
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url))
    },
  }, server: {
        proxy: {
            '/api': {
                target: 'https://idc.duncai.top/', // 外部 URL
                changeOrigin: true,
                rewrite: path => path.replace(/^\/api/, '')
            }
        }
    }
};

})