<script setup lang="ts">
import { ref, onMounted, getCurrentInstance } from 'vue'

// 兼容：优先用 modelValue，没有就兜底 value
const props = defineProps<{ modelValue?: string; value?: string }>()
const emit = defineEmits<{ (e: 'update:modelValue', v: string): void }>()
const getVal = () => (props.modelValue ?? props.value ?? '#ffffff')

const Comp = ref<any>(null)
onMounted(() => {
  const inst = getCurrentInstance()
  const comps = inst?.appContext?.components || {}
  // antd 可能注册成 AColorPicker 或 ColorPicker
  Comp.value = comps['AColorPicker'] || comps['ColorPicker'] || null
})

const onNativeInput = (e: Event) => {
  let v = (e.target as HTMLInputElement).value || ''
  if (v && !v.startsWith('#')) v = '#' + v
  emit('update:modelValue', v.toLowerCase())
}
</script>

<template>
  <component
      v-if="Comp"
      :is="Comp"
      :value="getVal()"
      format="hex"
      :disabledAlpha="true"
      @update:value="v => emit('update:modelValue', v)"
  />
  <input
      v-else
      type="color"
      :value="getVal()"
      @input="onNativeInput"
      class="color-input"
  />
</template>

<style scoped>
.color-input{
  width: 40px;
  height: 24px;
  padding: 0;
  border: 1px solid #e5e7eb;
  border-radius: 6px;
  background: transparent;
  cursor: pointer;
}
</style>
