<script setup lang="ts">
import { ref, reactive, onMounted, onBeforeUnmount, watch, computed, nextTick } from 'vue'
import { message } from 'ant-design-vue'
import { FluidBackground } from '@/assets/fluid-bg.ts'
import SmartColorPicker from '@/components/SmartColorPicker.vue'

type RGB = [number, number, number]
type Layer = { hex: string; centerAlpha: number; midAlpha: number; edgeAlpha: number }
type Breath = { enable: boolean; scaleMin: number; scaleMax: number; opacityMin: number; opacityMax: number; speed: number; phase: number }
type Drift = { ax: number; ay: number; sx: number; sy: number; speed: number }
type BlobItem = {
  id: string
  diameter: string
  centerX: string | ((d:{w:number,h:number,vMax:number})=>{x:number,y:number})
  centerY: string | undefined
  opacity: number
  parallaxScale: number
  layers: Layer[]
  drift: Drift
  breath: Breath
}



const frameRef   = ref<HTMLDivElement|null>(null)
const scaleWrap  = ref<HTMLDivElement|null>(null)
const canvasRef  = ref<HTMLCanvasElement|null>(null)
const overlayRef = ref<HTMLCanvasElement|null>(null)
let fb: FluidBackground | null = null

const design = reactive({ w: 0, h: 0 })
const scaleState = reactive({ s: 1, offX: 0, offY: 0 })

const globalOpts = reactive({
  alpha: 0.50, blurPx: 36, parallaxVmax: 1.0, fpsCap: 0,
  composite: 'source-over' as GlobalCompositeOperation,
  livePreview: true
})

const ui = reactive({
  positionUnit: 'percent' as 'percent'|'px',
  sizeUnit: 'vmax' as 'vmax'|'px',
  frameBg: '#f5f7fb',
  canvasBg: '#ffffff',
  showCanvasBorder: true,
})

const colorPresets = [
  { label: 'Theme', colors: ['#6d6afc', '#b9a9ff', '#7fd8ff', '#ffd166', '#06d6a0', '#ef476f'] },
  { label: 'Greys', colors: ['#111', '#333', '#666', '#999', '#ccc', '#eee'] }
]

// 示例数据
const C1 = '#6d6afc', C2 = '#b9a9ff', C3 = '#7fd8ff'
const blobs = reactive<BlobItem[]>([
  {
    id: 'b1', diameter: '72vmax',
    centerX: (d)=>({ x: (-22 + 36)/100 * d.vMax, y: d.h - ((-28 + 36)/100 * d.vMax) }),
    centerY: undefined, opacity: 1, parallaxScale: 1,
    layers: [
      { hex: C1, centerAlpha:.65, midAlpha:.28, edgeAlpha:0 },
      { hex: C2, centerAlpha:.55, midAlpha:.22, edgeAlpha:0 },
    ],
    drift: { ax:2, ay:1, sx:1, sy:1, speed:1/36 },
    breath: { enable:true, scaleMin:0.99, scaleMax:1.015, opacityMin:.9, opacityMax:1, speed:1/42, phase:0.1 }
  },
  {
    id: 'b2', diameter: '76vmax',
    centerX: (d)=>({ x: d.w - ((-24 + 38)/100 * d.vMax), y: ((-26 + 38)/100 * d.vMax) }),
    centerY: undefined, opacity: 1, parallaxScale: 1,
    layers: [
      { hex: C2, centerAlpha:.60, midAlpha:.26, edgeAlpha:0 },
      { hex: C3, centerAlpha:.50, midAlpha:.20, edgeAlpha:0 },
    ],
    drift: { ax:1, ay:2, sx:-2, sy:1, speed:1/42 },
    breath: { enable:true, scaleMin:0.985, scaleMax:1.02, opacityMin:.85, opacityMax:1, speed:1/48, phase:0.4 }
  },
  {
    id: 'b3', diameter: '64vmax',
    centerX: '38vmax', centerY: '22vmax', opacity: 0.88, parallaxScale: 0.85,
    layers: [ { hex: C1, centerAlpha:.48, midAlpha:.18, edgeAlpha:0 } ],
    drift: { ax:-1, ay:1, sx:2, sy:-1, speed:1/48 },
    breath: { enable:true, scaleMin:0.99, scaleMax:1.01, opacityMin:1, opacityMax:1, speed:1/50, phase:0.2 }
  }
])

// ===== 工具函数 =====
const clamp = (v:number,a:number,b:number)=>Math.min(b, Math.max(a, v))
function hexToRgb(hex: string): RGB {
  const s = hex.replace('#','').trim()
  const full = s.length === 3 ? s.split('').map(c=>c+c).join('') : s
  const n = parseInt(full, 16); return [(n>>16)&255, (n>>8)&255, n&255]
}
function unitToPx(v: number|string, dims:{w:number,h:number,vMax:number}, axis:'x'|'y'|'vmax') {
  if (typeof v === 'number') return v
  const s = String(v).trim()
  if (s.endsWith('px'))   return parseFloat(s)
  if (s.endsWith('%'))    return (axis==='y' ? dims.h : dims.w) * (parseFloat(s)/100)
  if (s.endsWith('vw'))   return dims.w * (parseFloat(s)/100)
  if (s.endsWith('vh'))   return dims.h * (parseFloat(s)/100)
  if (s.endsWith('vmax')) return dims.vMax * (parseFloat(s)/100)
  const n = parseFloat(s); return isNaN(n)?0:n
}
function getDims() { return { w: design.w, h: design.h, vMax: Math.max(design.w, design.h) } }
function resolveCenterPx(b: BlobItem, dims = getDims()) {
  if (typeof b.centerX === 'function') { const p = b.centerX(dims); return { x: p.x, y: p.y } }
  return { x: unitToPx(b.centerX, dims, 'x'), y: unitToPx(b.centerY ?? '50%', dims, 'y') }
}
function diameterPx(b: BlobItem, dims = getDims()) { return unitToPx(b.diameter, dims, 'vmax') }

// ===== FB 配置 =====
function toFbConfig(b: BlobItem){
  const layers = b.layers.map(l => ({
    color: hexToRgb(l.hex) as RGB,
    centerAlpha: l.centerAlpha, midAlpha: l.midAlpha, edgeAlpha: l.edgeAlpha
  }))
  const center = (typeof b.centerX === 'function')
      ? b.centerX
      : { x: b.centerX as string, y: (b.centerY ?? '50%') as string }

  const breath = b.breath.enable ? {
    scale: [b.breath.scaleMin, b.breath.scaleMax],
    opacity: [b.breath.opacityMin, b.breath.opacityMax],
    speed: b.breath.speed, phase: b.breath.phase
  } : null

  return { id: b.id, diameter: b.diameter, center, layers,
    opacity: b.opacity, parallaxScale: b.parallaxScale, drift: { ...b.drift }, breath }
}

// ===== 等比缩放 & 叠加层 =====
function computeScale() {
  const frame = frameRef.value!
  const rect = frame.getBoundingClientRect()
  const s = Math.min(rect.width / design.w, rect.height / design.h)
  const offX = (rect.width  - design.w * s) / 2
  const offY = (rect.height - design.h * s) / 2
  scaleState.s = s; scaleState.offX = offX; scaleState.offY = offY

  const el = scaleWrap.value!
  el.style.width = `${design.w}px`
  el.style.height = `${design.h}px`
  el.style.transform = `translate(${offX}px, ${offY}px) scale(${s})`
  el.style.transformOrigin = 'top left'
  el.style.background = ui.canvasBg
  el.style.border = ui.showCanvasBorder ? '1px solid #e5e7eb' : 'none'
  el.style.boxShadow = ui.showCanvasBorder ? '0 6px 24px rgba(0,0,0,0.06)' : 'none'
}
function sizeOverlay(){
  const frame = frameRef.value!, cvs = overlayRef.value!
  const rect = frame.getBoundingClientRect()
  const ratio = window.devicePixelRatio || 1
  cvs.style.width = `${rect.width}px`; cvs.style.height = `${rect.height}px`
  cvs.width = Math.round(rect.width*ratio); cvs.height=Math.round(rect.height*ratio)
}
function drawOverlay(tempRadiusPx?: number){
  const cvs = overlayRef.value; if (!cvs) return
  sizeOverlay()
  const ctx = cvs.getContext('2d')!
  const ratio = window.devicePixelRatio || 1
  const dims = getDims()
  const s = scaleState.s, offX = scaleState.offX, offY = scaleState.offY
  const rect = frameRef.value!.getBoundingClientRect()

  ctx.setTransform(ratio,0,0,ratio,0,0)
  ctx.clearRect(0,0,rect.width, rect.height)

  if (selectedIndex.value===null) return
  const b = blobs[selectedIndex.value]
  const c0 = resolveCenterPx(b, dims)
  const r0 = (tempRadiusPx ?? (diameterPx(b, dims)/2))
  const cx = offX + c0.x * s
  const cy = offY + c0.y * s
  const rr = r0 * s

  ctx.beginPath(); ctx.strokeStyle='rgba(105,104,253,0.9)'; ctx.lineWidth=2
  ctx.arc(cx, cy, rr*0.95, 0, Math.PI*2); ctx.stroke()

  ctx.beginPath(); ctx.fillStyle='rgba(0,0,0,0.35)'; ctx.arc(cx, cy, 3, 0, Math.PI*2); ctx.fill()
  ctx.beginPath(); ctx.moveTo(cx-10,cy); ctx.lineTo(cx+10,cy); ctx.moveTo(cx,cy-10); ctx.lineTo(cx,cy+10)
  ctx.strokeStyle='rgba(0,0,0,0.25)'; ctx.lineWidth=1; ctx.stroke()

  const handleSize = 10
  const hx = cx + rr * Math.cos(Math.PI/4)
  const hy = cy + rr * Math.sin(Math.PI/4)
  ctx.beginPath()
  ctx.fillStyle = '#6d6afc'
  ctx.arc(hx, hy, handleSize, 0, Math.PI*2)
  ctx.fill()
  ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(hx, hy)
  ctx.strokeStyle = 'rgba(109,106,252,0.6)'; ctx.lineWidth=2; ctx.stroke()

  const dPx = Math.round(r0*2)
  const dVmax = (r0*2 / dims.vMax * 100).toFixed(2) + 'vmax'
  const text = ui.sizeUnit==='vmax' ? dVmax : `${dPx}px`
  const tip = `diameter: ${text}`
  ctx.font = '12px system-ui'
  const pad=6, w=ctx.measureText(tip).width+pad*2, h=22
  const bx = clamp(hx+12,8, rect.width-w-8), by = clamp(hy-12-h, 8, rect.height-h-8)
  ctx.fillStyle='rgba(255,255,255,0.95)'; ctx.strokeStyle='rgba(0,0,0,0.15)'; ctx.lineWidth=1
  // @ts-ignore
  ctx.roundRect?.(bx,by,w,h,6); ctx.fill(); ctx.stroke()
  ctx.fillStyle='#333'; ctx.fillText(tip, bx+pad, by+14)
}

// ===== 增量同步（关键！）=====
const syncedHashes: Record<string, string> = {}   // id -> hash
const lastGlobal = reactive({ alpha:-1, blurPx:-1, parallaxVmax:-1, fpsCap:-1, composite:'' })

function hashBlob(b: BlobItem) {
  const cfg = toFbConfig(b)
  return JSON.stringify({
    id: cfg.id,
    diameter: cfg.diameter,
    center: cfg.center,
    opacity: cfg.opacity,
    parallaxScale: cfg.parallaxScale,
    layers: cfg.layers,
    drift: cfg.drift,
    breath: cfg.breath || undefined,
  })
}

function syncGlobals(hard=false) {
  if (!fb) return
  if (globalOpts.alpha !== lastGlobal.alpha) { fb.setAlpha(globalOpts.alpha); lastGlobal.alpha = globalOpts.alpha }
  if (globalOpts.parallaxVmax !== lastGlobal.parallaxVmax) { fb.setParallax(globalOpts.parallaxVmax); lastGlobal.parallaxVmax = globalOpts.parallaxVmax }
  if (globalOpts.fpsCap !== lastGlobal.fpsCap) { fb.setFpsCap(globalOpts.fpsCap); lastGlobal.fpsCap = globalOpts.fpsCap }
  if (globalOpts.composite !== lastGlobal.composite) { fb.setComposite(globalOpts.composite); lastGlobal.composite = globalOpts.composite }
  if (hard || globalOpts.blurPx !== lastGlobal.blurPx) { fb.setBlurPx(globalOpts.blurPx); lastGlobal.blurPx = globalOpts.blurPx }
}

function syncBlobs() {
  if (!fb) return
  // 删除已不存在的
  const uiIds = new Set(blobs.map(b => b.id))
  Object.keys(syncedHashes).forEach(id => {
    if (!uiIds.has(id)) { fb!.removeBlob(id); delete syncedHashes[id] }
  })
  // 新增/更新
  blobs.forEach(b => {
    const h = hashBlob(b)
    if (!syncedHashes[b.id]) {
      fb!.addBlob(toFbConfig(b))
      syncedHashes[b.id] = h
    } else if (syncedHashes[b.id] !== h) {
      fb!.updateBlob(b.id, toFbConfig(b))
      syncedHashes[b.id] = h
    }
  })
}

function syncAll(hard=false) {
  syncGlobals(hard)
  syncBlobs()
  computeScale(); sizeOverlay(); drawOverlay()
}

// ===== 初始化（只做一次）=====
async function initFluidOnce() {
  design.w = window.innerWidth
  design.h = window.innerHeight
  if (!fb) {
    await nextTick()
    fb = new FluidBackground(canvasRef.value!, {
      alpha: globalOpts.alpha, blurPx: globalOpts.blurPx,
      parallaxVmax: globalOpts.parallaxVmax, fpsCap: globalOpts.fpsCap,
      composite: globalOpts.composite, autoStart: true
    })
  }
  syncAll(true)
}

// 手动应用（在“手动预览模式”下也不重建实例）
function applyManually(){ syncAll(true) }

// ===== 交互：选择/拖拽/缩放 =====
const selectedIndex = ref<number|null>(null)
let dragging = false
let resizing = false
let dragStart = { x: 0, y: 0 }
let startCenter = { x: 0, y: 0 }
let hasCanvasFocus = false

function setCanvasPointerThrough(on:boolean){
  const el = canvasRef.value
  if (el) el.style.pointerEvents = on ? 'none' : 'auto'
}

function getScaleAndRect(){
  const frame = frameRef.value!
  const rect = frame.getBoundingClientRect()
  return { s: scaleState.s, offX: scaleState.offX, offY: scaleState.offY, rect }
}
function getPointerDesign(e: PointerEvent){
  const { rect, s, offX, offY } = getScaleAndRect()
  const xScreen = e.clientX - rect.left - offX
  const yScreen = e.clientY - rect.top  - offY
  return { x: xScreen / s, y: yScreen / s }
}
function pickBlobAtDesign(x:number, y:number) {
  const dims = getDims()
  for (let i = blobs.length - 1; i >= 0; i--) {
    const b = blobs[i]
    const c = resolveCenterPx(b, dims)
    const d = Math.hypot(x - c.x, y - c.y)
    const r = diameterPx(b, dims) / 2
    if (d <= r * 0.90) return { index: i, hit: 'inside' as const }
    const ringHitTol = 18
    if (Math.abs(d - r) <= ringHitTol) return { index: i, hit: 'ring' as const }
  }
  return null
}

function writeCenter(b: BlobItem, xDesign:number, yDesign:number, shift=false){
  const dims = getDims()
  let nx = xDesign, ny = yDesign
  if (shift){
    if (ui.positionUnit === 'percent'){
      const sx = Math.round((nx/dims.w*100)/1)*1
      const sy = Math.round((ny/dims.h*100)/1)*1
      nx = sx/100*dims.w; ny = sy/100*dims.h
    }else{
      const step = 10
      nx = Math.round(nx/step)*step; ny = Math.round(ny/step)*step
    }
  }
  if (typeof b.centerX === 'function'){
    const now = resolveCenterPx(b, dims)
    b.centerX = ui.positionUnit==='percent'? `${(now.x/dims.w*100).toFixed(2)}%` : `${Math.round(now.x)}px`
    b.centerY = ui.positionUnit==='percent'? `${(now.y/dims.h*100).toFixed(2)}%` : `${Math.round(now.y)}px`
  }
  if (ui.positionUnit === 'percent'){
    b.centerX = `${clamp(+((nx/dims.w*100).toFixed(2)),0,100)}%`
    b.centerY = `${clamp(+((ny/dims.h*100).toFixed(2)),0,100)}%`
  }else{
    b.centerX = `${Math.round(clamp(nx,0,dims.w))}px`
    b.centerY = `${Math.round(clamp(ny,0,dims.h))}px`
  }
}

function writeDiameter(b: BlobItem, newDiamPx:number, shift=false){
  const dims = getDims()
  let d = clamp(newDiamPx, 16, Math.max(dims.w, dims.h)*2)
  if (shift){
    if (ui.sizeUnit==='vmax'){
      const step = dims.vMax * 0.01 // 1vmax
      d = Math.round(d/step)*step
    }else{
      const step = 10 // 10px
      d = Math.round(d/step)*step
    }
  }
  if (ui.sizeUnit==='vmax'){
    const val = (d / dims.vMax) * 100
    b.diameter = `${val.toFixed(2)}vmax`
  }else{
    b.diameter = `${Math.round(d)}px`
  }
}

function onPointerDown(e: PointerEvent){
  hasCanvasFocus = true
  setCanvasPointerThrough(true)
  const p = getPointerDesign(e)
  const pick = pickBlobAtDesign(p.x, p.y)
  selectedIndex.value = pick ? pick.index : null
  resizing = false
  dragging = false

  if (!pick){ drawOverlay(); return }
  const b = blobs[pick.index]
  const c = resolveCenterPx(b)

  if (pick.hit === 'ring') {
    resizing = true
  } else if (pick.hit === 'inside') {
    dragging = true
    dragStart = p
    startCenter = { x: c.x, y: c.y }
  }

  ;(e.target as Element).setPointerCapture?.(e.pointerId)
  drawOverlay()
}

function onPointerMove(e: PointerEvent){
  if (selectedIndex.value===null) return
  if (!dragging && !resizing) return

  const p = getPointerDesign(e)
  const b = blobs[selectedIndex.value]
  const c = resolveCenterPx(b)

  if (resizing){
    const dist = Math.hypot(p.x - c.x, p.y - c.y)
    drawOverlay(dist)
  } else if (dragging){
    let dx = p.x - dragStart.x, dy = p.y - dragStart.y
    if (e.altKey){ if (Math.abs(dx)>Math.abs(dy)) dy=0; else dx=0 }
    writeCenter(b, startCenter.x+dx, startCenter.y+dy, e.shiftKey)
    queueRender(true); drawOverlay()
  }
}

function onPointerUp(e: PointerEvent){
  if (selectedIndex.value!==null && resizing){
    const p = getPointerDesign(e)
    const b = blobs[selectedIndex.value]
    const c = resolveCenterPx(b)
    const dist = Math.hypot(p.x - c.x, p.y - c.y)
    writeDiameter(b, dist*2, (e as any).shiftKey === true)
    queueRender(true)
  }
  dragging = false
  resizing = false
  setCanvasPointerThrough(false)
  ;(e.target as Element).releasePointerCapture?.(e.pointerId)
  drawOverlay()
}

function onClickCanvas(e: MouseEvent){
  const { rect, offX, offY, s } = getScaleAndRect()
  const xScreen = (e.clientX - rect.left - offX), yScreen = (e.clientY - rect.top - offY)
  const pick = pickBlobAtDesign(xScreen/s, yScreen/s)
  if (!pick){ selectedIndex.value=null; drawOverlay() }
}

// ===== 复制 / 粘贴 =====
function deepCloneBlob(b: BlobItem): BlobItem {
  const dims = getDims()
  let center: {x:string,y:string}
  if (typeof b.centerX === 'function') {
    const p = resolveCenterPx(b, dims)
    center = ui.positionUnit==='percent'
        ? { x:`${(p.x/dims.w*100).toFixed(2)}%`, y:`${(p.y/dims.h*100).toFixed(2)}%` }
        : { x:`${Math.round(p.x)}px`, y:`${Math.round(p.y)}px` }
  } else {
    center = { x: String(b.centerX), y: String(b.centerY ?? '50%') }
  }
  return {
    id: `copy-${Date.now()%100000}`,
    diameter: b.diameter,
    centerX: center.x, centerY: center.y,
    opacity: b.opacity, parallaxScale: b.parallaxScale,
    layers: b.layers.map(l => ({ ...l })), drift: { ...b.drift }, breath: { ...b.breath }
  }
}
function offsetBlobPosition(b: BlobItem, step = 0.03){
  const dims = getDims()
  if (ui.positionUnit==='percent'){
    const px = parseFloat(String(b.centerX).replace('%','')) + step*100
    const py = parseFloat(String(b.centerY).replace('%','')) + step*100
    b.centerX = `${clamp(+px.toFixed(2),0,100)}%`
    b.centerY = `${clamp(+py.toFixed(2),0,100)}%`
  }else{
    const px = parseFloat(String(b.centerX).replace('px','')) + 30
    const py = parseFloat(String(b.centerY).replace('px','')) + 30
    b.centerX = `${clamp(Math.round(px),0,dims.w)}px`
    b.centerY = `${clamp(Math.round(py),0,dims.h)}px`
  }
}
function duplicateBlob(i: number){
  const copy = deepCloneBlob(blobs[i]); offsetBlobPosition(copy)
  blobs.splice(i+1, 0, copy); selectedIndex.value = i+1
  queueRender(true); drawOverlay()
}
let clipboardBlob: BlobItem | null = null
function onKeyDown(e: KeyboardEvent){
  if (!hasCanvasFocus) return
  const meta = e.ctrlKey || e.metaKey
  if (!meta) return
  const tag = (document.activeElement?.tagName || '').toLowerCase()
  if (tag==='input' || tag==='textarea') return
  if (e.key.toLowerCase()==='c'){
    e.preventDefault()
    if (selectedIndex.value!=null){ clipboardBlob = deepCloneBlob(blobs[selectedIndex.value]); message.success('已复制 Blob', 0.6) }
  }else if (e.key.toLowerCase()==='v'){
    e.preventDefault()
    if (clipboardBlob){
      const paste = deepCloneBlob(clipboardBlob); offsetBlobPosition(paste)
      blobs.push(paste); selectedIndex.value = blobs.length-1
      queueRender(true); drawOverlay()
    }
  }
}

// ===== FPS & 性能提示 =====
const fps = ref(60)
let fpsRaf = 0, lastTs = 0
function fpsLoop(ts:number){
  if (!lastTs) lastTs = ts
  const dt = ts - lastTs; lastTs = ts
  const f = dt>0 ? 1000/dt : 60
  fps.value = Math.round(f*0.2 + fps.value*0.8)
  fpsRaf = requestAnimationFrame(fpsLoop)
}
function stopFps(){ cancelAnimationFrame(fpsRaf); fpsRaf = 0; lastTs = 0 }
const perfWarnings = computed(()=>{
  const layerCount = blobs.reduce((s,b)=>s + b.layers.length, 0)
  const risk: string[] = []
  if (globalOpts.blurPx > 40) risk.push('模糊半径较大，建议 ≤ 36')
  if (layerCount > 10) risk.push(`颜色层较多（${layerCount}）→ 合成开销变大`)
  if (globalOpts.composite !== 'source-over') risk.push(`混合模式 ${globalOpts.composite} 可能增加开销`)
  if (fps.value < 45) risk.push(`实时 FPS ≈ ${fps.value}，可尝试：降低 blurPx、减少层数、设置 fpsCap=30`)
  return risk
})

// ===== 实时监听：颜色/数值一改就刷新 =====
watch(blobs, () => { queueRender(true) }, { deep: true })
watch(globalOpts, () => { queueRender(false) }, { deep: true })
watch(() => [ui.canvasBg, ui.showCanvasBorder, ui.sizeUnit, ui.positionUnit], () => {
  computeScale(); drawOverlay()
})

// ===== 映射 Segmented 的字符串值 <-> 布尔 =====
const previewMode = computed<string>({
  get: () => globalOpts.livePreview ? 'live' : 'manual',
  set: (v) => { globalOpts.livePreview = (v === 'live'); queueRender(true) }
})
const borderMode = computed<string>({
  get: () => ui.showCanvasBorder ? 'show' : 'hide',
  set: (v) => { ui.showCanvasBorder = (v === 'show'); computeScale(); drawOverlay() }
})

// ===== 生命周期 & 渲染队列 =====
function onResize(){
  design.w = window.innerWidth
  design.h = window.innerHeight
  computeScale(); sizeOverlay(); drawOverlay()
  queueRender(true)
}

onMounted(() => {
  initFluidOnce()
  const el = frameRef.value!

  el.addEventListener('pointerdown', onPointerDown)
  el.addEventListener('pointermove', onPointerMove)
  el.addEventListener('pointerup', onPointerUp)
  el.addEventListener('click', onClickCanvas)
  window.addEventListener('resize', onResize)
  window.addEventListener('keydown', onKeyDown)
  fpsRaf = requestAnimationFrame(fpsLoop)
})

onBeforeUnmount(() => {
  fb?.destroy(); fb=null
  const el = frameRef.value
  if (el){
    el.removeEventListener('pointerdown', onPointerDown)
    el.removeEventListener('pointermove', onPointerMove)
    el.removeEventListener('pointerup', onPointerUp)
    el.removeEventListener('click', onClickCanvas)
  }
  window.removeEventListener('resize', onResize)
  window.removeEventListener('keydown', onKeyDown)
  stopFps()
})

// rAF 防抖（仅同步，不重建）
let rafId = 0
function queueRender(immediate=false){
  if (!globalOpts.livePreview && !immediate) return
  if (rafId) cancelAnimationFrame(rafId)
  rafId = requestAnimationFrame(() => {
    syncAll(false); rafId = 0
  })
}

// JSON 导入/导出（不变，导入后触发 queueRender）
const configJson = computed({
  get(){
    const safe = blobs.map(b => ({
      id: b.id, diameter: b.diameter,
      center: (typeof b.centerX==='function') ? '/* function(d){...} */' : { x:b.centerX, y:b.centerY },
      opacity: b.opacity, parallaxScale: b.parallaxScale, layers: b.layers, drift: b.drift, breath: b.breath
    }))
    return JSON.stringify({ global: {...globalOpts}, ui: {...ui}, blobs: safe }, null, 2)
  },
  set(v: string){
    try{
      const obj = JSON.parse(v)
      if (obj.global){
        globalOpts.alpha = clamp(Number(obj.global.alpha ?? globalOpts.alpha), 0, 1)
        globalOpts.blurPx = Number(obj.global.blurPx ?? globalOpts.blurPx)
        globalOpts.parallaxVmax = Number(obj.global.parallaxVmax ?? globalOpts.parallaxVmax)
        globalOpts.fpsCap = Number(obj.global.fpsCap ?? globalOpts.fpsCap)
        globalOpts.composite = (obj.global.composite ?? globalOpts.composite)
      }
      if (obj.ui){
        ui.positionUnit = (obj.ui.positionUnit==='px'?'px':'percent') as any
        ui.sizeUnit = (obj.ui.sizeUnit==='px'?'px':'vmax') as any
        ui.frameBg = obj.ui.frameBg ?? ui.frameBg
        ui.canvasBg = obj.ui.canvasBg ?? ui.canvasBg
        ui.showCanvasBorder = !!obj.ui.showCanvasBorder
      }
      if (!Array.isArray(obj.blobs)) throw new Error('blobs 缺失或格式不正确')
      const next = obj.blobs.map((b:any): BlobItem => ({
        id: b.id || `b${Date.now()%100000}`,
        diameter: b.diameter ?? '64vmax',
        centerX: (typeof b.center === 'object' && b.center?.x) ? b.center.x : '50%',
        centerY: (typeof b.center === 'object' && b.center?.y) ? b.center.y : '50%',
        opacity: clamp(Number(b.opacity ?? 1), 0, 1),
        parallaxScale: Number(b.parallaxScale ?? 1),
        layers: Array.isArray(b.layers) ? b.layers.map((l:any)=>({
          hex: l.hex ?? '#8888ff',
          centerAlpha: Number(l.centerAlpha ?? .6),
          midAlpha: Number(l.midAlpha ?? .25),
          edgeAlpha: Number(l.edgeAlpha ?? 0),
        })) : [],
        drift: {
          ax: Number(b.drift?.ax ?? 1), ay: Number(b.drift?.ay ?? 1),
          sx: Number(b.drift?.sx ?? 1), sy: Number(b.drift?.sy ?? 1),
          speed: Number(b.drift?.speed ?? 1/48),
        },
        breath: {
          enable: Boolean(b.breath?.enable ?? true),
          scaleMin: Number(b.breath?.scaleMin ?? 0.99),
          scaleMax: Number(b.breath?.scaleMax ?? 1.01),
          opacityMin: Number(b.breath?.opacityMin ?? 1.0),
          opacityMax: Number(b.breath?.opacityMax ?? 1.0),
          speed: Number(b.breath?.speed ?? 1/48),
          phase: Number(b.breath?.phase ?? 0),
        }
      }))
      blobs.splice(0, blobs.length, ...next)
      queueRender(true)
      message.success('JSON 已导入并应用', 0.8)
    }catch(e:any){ message.error('JSON 解析失败：' + e?.message) }
  }
})
const saveToLocal = ()=>{ localStorage.setItem('fluid-bg-editor', configJson.value); message.success('已保存到本地', 0.8) }
const loadFromLocal = ()=>{ const v = localStorage.getItem('fluid-bg-editor'); if (!v) return message.info('没有本地保存的配置'); configJson.value = v }

watch(() => ui.canvasBg, (v) => {
  if (canvasRef.value) canvasRef.value.style.background = v
})
</script>

<template>
  <div class="editor-wrap">
    <div class="canvas-pane" :style="{ background: ui.frameBg }">
      <div ref="frameRef" class="frame">
        <div ref="scaleWrap" class="scale-wrap">
          <canvas ref="canvasRef" class="fluid-canvas" aria-hidden="true"></canvas>
        </div>
        <canvas ref="overlayRef" class="overlay-canvas"></canvas>
      </div>

      <div class="hud">
        <div>FPS：{{ fps }}</div>
        <div v-if="perfWarnings.length" class="warn">
          <div v-for="(w,i) in perfWarnings" :key="i">• {{ w }}</div>
        </div>
      </div>
    </div>

    <div class="side-pane">
      <a-segmented
          v-model:value="previewMode"
          :options="[{label:'实时预览', value:'live'},{label:'手动应用', value:'manual'}]"
          class="seg"
      />

      <a-card size="small" title="画布与背景" :bordered="false" class="card">
        <a-row :gutter="12">
          <a-col :span="12">
            <a-form-item label="画布外背景（frame）">
              <SmartColorPicker v-model="ui.frameBg" :presets="colorPresets" format="hex" :disabledAlpha="true"/>
            </a-form-item>
          </a-col>
          <a-col :span="12">
            <a-form-item label="画布底色（canvas）">
              <SmartColorPicker v-model="ui.canvasBg" :presets="colorPresets" format="hex" :disabledAlpha="true" />
            </a-form-item>
          </a-col>
          <a-col :span="12">
            <a-form-item label="画布边框">
              <a-segmented v-model:value="borderMode" :options="[{label:'显示',value:'show'},{label:'隐藏',value:'hide'}]"/>
            </a-form-item>
          </a-col>
          <a-col :span="12">
            <a-form-item label="尺寸单位（直径）">
              <a-segmented v-model:value="ui.sizeUnit" :options="['vmax','px']" />
            </a-form-item>
          </a-col>
          <a-col :span="24">
            <a-form-item label="位置单位（拖拽写回）">
              <a-segmented v-model:value="ui.positionUnit" :options="['percent','px']" />
            </a-form-item>
          </a-col>
        </a-row>
      </a-card>

      <a-card size="small" title="Blobs（拖动移动；拖边改大小；Ctrl/Cmd+C/V）" :bordered="false" class="card">
        <a-collapse accordion>
          <a-collapse-panel
              v-for="(b, i) in blobs" :key="b.id"
              :header="`${b.id} — ${b.diameter}`"
              :extra="selectedIndex===i ? '● 已选中' : ''"
          >
            <a-form layout="vertical">
              <a-row :gutter="12">
                <a-col :span="12"><a-form-item label="ID"><a-input v-model:value="b.id" /></a-form-item></a-col>
                <a-col :span="12"><a-form-item label="直径"><a-input v-model:value="b.diameter" placeholder="64vmax / 800px"/></a-form-item></a-col>

                <a-col :span="12"><a-form-item label="中心 X">
                  <a-input :disabled="typeof b.centerX==='function'" v-model:value="(b.centerX as string)" placeholder="50% / 30vmax / 200px"/>
                </a-form-item></a-col>
                <a-col :span="12"><a-form-item label="中心 Y">
                  <a-input :disabled="typeof b.centerX==='function'" v-model:value="(b.centerY as string)" placeholder="40% / 20vmax / 200px"/>
                </a-form-item></a-col>

                <a-col :span="12"><a-form-item label="opacity"><a-slider :min="0" :max="1" :step="0.01" v-model:value="b.opacity"/></a-form-item></a-col>
                <a-col :span="12"><a-form-item label="parallaxScale"><a-input-number v-model:value="b.parallaxScale" :min="0" :step="0.05" style="width:100%"/></a-form-item></a-col>
              </a-row>

              <a-divider>颜色层（可视化选择）</a-divider>
              <div v-for="(l, li) in b.layers" :key="li" class="layer-row">
                <a-row :gutter="8" align="middle">
                  <a-col :span="8"><a-form-item label="颜色">
                    <SmartColorPicker v-model="l.hex" :presets="colorPresets" format="hex" :disabledAlpha="true" />
                  </a-form-item></a-col>
                  <a-col :span="5"><a-form-item label="center"><a-input-number v-model:value="l.centerAlpha" :min="0" :max="1" :step="0.01" style="width:100%"/></a-form-item></a-col>
                  <a-col :span="5"><a-form-item label="mid"><a-input-number v-model:value="l.midAlpha" :min="0" :max="1" :step="0.01" style="width:100%"/></a-form-item></a-col>
                  <a-col :span="5"><a-form-item label="edge"><a-input-number v-model:value="l.edgeAlpha" :min="0" :max="1" :step="0.01" style="width:100%"/></a-form-item></a-col>
                  <a-col :span="1" style="text-align:right;"><a-button danger shape="circle" size="small" @click="b.layers.splice(li,1)">×</a-button></a-col>
                </a-row>
              </div>
              <a-button size="small" @click="b.layers.push({ hex:'#9999ff', centerAlpha:.5, midAlpha:.2, edgeAlpha:0 })">+ 增加一层</a-button>

              <a-divider>漂移 Drift</a-divider>
              <a-row :gutter="8">
                <a-col :span="8"><a-form-item label="ax"><a-input-number v-model:value="b.drift.ax" :step="0.5" style="width:100%"/></a-form-item></a-col>
                <a-col :span="8"><a-form-item label="ay"><a-input-number v-model:value="b.drift.ay" :step="0.5" style="width:100%"/></a-form-item></a-col>
                <a-col :span="8"><a-form-item label="speed"><a-input-number v-model:value="b.drift.speed" :step="0.001" style="width:100%"/></a-form-item></a-col>
                <a-col :span="8"><a-form-item label="sx"><a-input-number v-model:value="b.drift.sx" :step="0.5" style="width:100%"/></a-form-item></a-col>
                <a-col :span="8"><a-form-item label="sy"><a-input-number v-model:value="b.drift.sy" :step="0.5" style="width:100%"/></a-form-item></a-col>
              </a-row>

              <a-divider>呼吸 Breath</a-divider>
              <a-space align="center" style="margin-bottom:8px;"><a-switch v-model:checked="b.breath.enable" /><span>启用</span></a-space>
              <a-row :gutter="8" v-if="b.breath.enable">
                <a-col :span="12"><a-form-item label="scaleMin"><a-input-number v-model:value="b.breath.scaleMin" :min="0.8" :max="1.2" :step="0.001" style="width:100%"/></a-form-item></a-col>
                <a-col :span="12"><a-form-item label="scaleMax"><a-input-number v-model:value="b.breath.scaleMax" :min="0.8" :max="1.2" :step="0.001" style="width:100%"/></a-form-item></a-col>
                <a-col :span="12"><a-form-item label="opacityMin"><a-input-number v-model:value="b.breath.opacityMin" :min="0" :max="1" :step="0.01" style="width:100%"/></a-form-item></a-col>
                <a-col :span="12"><a-form-item label="opacityMax"><a-input-number v-model:value="b.breath.opacityMax" :min="0" :max="1" :step="0.01" style="width:100%"/></a-form-item></a-col>
                <a-col :span="12"><a-form-item label="speed"><a-input-number v-model:value="b.breath.speed" :min="0.001" :step="0.001" style="width:100%"/></a-form-item></a-col>
                <a-col :span="12"><a-form-item label="phase"><a-input-number v-model:value="b.breath.phase" :min="0" :max="1" :step="0.01" style="width:100%"/></a-form-item></a-col>
              </a-row>

              <div class="row-btns">
                <a-space>
                  <a-button @click="duplicateBlob(i)">复制</a-button>
                  <a-button danger @click="blobs.splice(i,1)">删除</a-button>
                </a-space>
              </div>
            </a-form>
          </a-collapse-panel>
        </a-collapse>
      </a-card>

      <a-card size="small" title="JSON 导入 / 导出" :bordered="false" class="card">
        <a-typography-paragraph type="secondary" style="margin-bottom:8px;">
          画布：拖动移动；拖圆环/手柄改大小；<kbd>Shift</kbd> 吸附；<kbd>Alt</kbd> 轴向；<kbd>Ctrl/Cmd+C</kbd>/<kbd>V</kbd> 复制粘贴。
        </a-typography-paragraph>
        <a-textarea v-model:value="configJson" :rows="10" />
      </a-card>
    </div>
  </div>
</template>

<style scoped>

.fluid-canvas{ background: transparent; }  /* 画布透明 */
.scale-wrap{ background: #fff; }           /* 由它当“纸” */

.editor-wrap{
  display:grid;
  grid-template-columns: 1fr 420px;
  gap:16px;
  min-height:100dvh;
}
.canvas-pane{
  position:relative;
  border-right:1px solid #f0f0f0;
  min-height:100dvh;
  transition: background 0.2s ease;
}
.frame{
  position:relative;
  width:100%;
  height: calc(100dvh - 0px);
  overflow:hidden;
}
.scale-wrap{
  position:absolute; top:0; left:0;
  will-change: transform, background, border;
  border-radius: 10px;
}
.fluid-canvas{
  display:block;
  width:100%;
  height:100%;
  pointer-events:auto;
  border-radius: 10px;
}
.overlay-canvas{
  position:absolute; inset:0;
  pointer-events:none;
}
.overlay-canvas{ background: transparent; }

.hud{
  position:absolute; left:12px; bottom:12px;
  padding:8px 10px; border-radius:8px;
  background: rgba(255,255,255,0.9);
  box-shadow: 0 6px 24px rgba(0,0,0,0.06);
  font-size:12px; color:#333;
}
.hud .warn{ margin-top:4px; color:#a66; }
.side-pane{
  padding:12px 12px 24px;
  overflow:auto;
  max-height:100dvh;
  background:#fff;
}
.card{ margin-top:12px; }
.seg{ width:100%; margin-bottom:8px; }
.layer-row{ background:#fafafa; padding:8px; border-radius:8px; margin-bottom:8px; }
.row-btns{ margin-top:8px; display:flex; justify-content:flex-end; }
</style>
