import { createRouter, createWebHistory } from 'vue-router'
import HomeView from '../views/HomeView.vue'
import FluidBgEditor from "@/components/FluidBgEditor.vue";
const router = createRouter({
  history: createWebHistory(""),
  routes: [
    {
      path: '/',
      name: 'home',
      component: HomeView,
    },
      {
          path: '/fg',
          name: 'fg-editor',
          component: FluidBgEditor,
      },



  ],
})

export default router
