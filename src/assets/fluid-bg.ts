// fluid-bg.ts
// 轻量流体背景渲染器 —— 支持透明/不透明底、模糊、漂移、呼吸、混合模式、FPS 限制
// 与现有 Vue 代码严格对齐：setAlpha / setBlurPx / setParallax / setFpsCap / setComposite / addBlob / updateBlob / removeBlob / destroy

export type RGB = [number, number, number]

export type LayerSpec = {
    color: RGB
    centerAlpha: number
    midAlpha: number
    edgeAlpha: number
}

export type CenterFunc = (d: { w: number; h: number; vMax: number }) => { x: number; y: number }
export type CenterSpec = CenterFunc | { x: string; y: string }

export type BreathSpec = {
    scale: [number, number]
    opacity: [number, number]
    speed: number
    phase: number
} | null

export type DriftSpec = {
    ax: number
    ay: number
    sx: number
    sy: number
    speed: number // 周期速度（Hz 近似）
}

export type BlobConfig = {
    id: string
    diameter: string // 'px' | 'vmax'
    center: CenterSpec
    layers: LayerSpec[]
    opacity: number
    parallaxScale: number
    drift: DriftSpec
    breath: BreathSpec
}

export type FluidOptions = {
    alpha?: number               // 全局透明度乘子（0~1）
    blurPx?: number              // 模糊半径（px）
    parallaxVmax?: number        // 视差最大位移（vmax 基础，当前版本占位）
    fpsCap?: number              // 帧率上限（0=不限）
    composite?: GlobalCompositeOperation // 全局混合模式
    background?: string | null   // 画布底色（设为颜色则每帧先铺底；null/undefined=透明）
    autoStart?: boolean          // 自动开始渲染
    desynchronized?: boolean     // 是否开启无同步上下文
}

type InternalBlob = BlobConfig & {
    // 运行时缓存
    _diameterPx: number
}

type State = {
    running: boolean
    alpha: number
    blurPx: number
    parallaxVmax: number
    fpsCap: number
    composite: GlobalCompositeOperation
    background: string | null
    dpr: number
    cssW: number
    cssH: number
    lastFrameMs: number
    startMs: number
    desynchronized: boolean
}

const TAU = Math.PI * 2

export class FluidBackground {
    private canvas: HTMLCanvasElement
    private ctx: CanvasRenderingContext2D | null = null
    private rafId = 0
    private blobs = new Map<string, InternalBlob>()
    private state: State

    constructor(canvas: HTMLCanvasElement, opts: FluidOptions = {}) {
        this.canvas = canvas

        const wantOpaque = !!opts.background
        this.ctx = canvas.getContext('2d', {
            alpha: !wantOpaque, // 有底色时可让 backing store 不透明，避免黑底路径
            desynchronized: !!opts.desynchronized // 默认 false，更稳定
        })

        if (!this.ctx) throw new Error('2D context not available')

        this.state = {
            running: false,
            alpha: opts.alpha ?? 0.5,
            blurPx: opts.blurPx ?? 36,
            parallaxVmax: opts.parallaxVmax ?? 1.0,
            fpsCap: opts.fpsCap ?? 0,
            composite: opts.composite ?? 'source-over',
            background: opts.background ?? null,
            dpr: Math.max(1, window.devicePixelRatio || 1),
            cssW: 0,
            cssH: 0,
            lastFrameMs: 0,
            startMs: performance.now(),
            desynchronized: !!opts.desynchronized
        }

        // 初始化尺寸
        this.ensureSize()

        if (opts.autoStart !== false) {
            this.start()
        }
    }

    /** 外部 API —— 基础参数 */
    setAlpha(a: number) {
        this.state.alpha = clamp(a, 0, 1)
    }
    setBlurPx(px: number) {
        this.state.blurPx = Math.max(0, px|0)
    }
    setParallax(v: number) {
        this.state.parallaxVmax = v
    }
    setFpsCap(fps: number) {
        this.state.fpsCap = Math.max(0, fps|0)
    }
    setComposite(mode: GlobalCompositeOperation) {
        this.state.composite = mode
    }
    setBackground(color: string | null | undefined) {
        this.state.background = color ?? null
    }

    /** 外部 API —— 管理 Blobs */
    addBlob(cfg: Omit<BlobConfig, 'id'> & { id: string }) {
        const b = this.materialize(cfg)
        this.blobs.set(b.id, b)
    }
    updateBlob(id: string, cfg: Partial<BlobConfig>) {
        const prev = this.blobs.get(id)
        if (!prev) { if (cfg && (cfg as any).id) this.addBlob(cfg as BlobConfig); return }
        const next: InternalBlob = this.materialize({ ...prev, ...cfg, id: prev.id })
        this.blobs.set(id, next)
    }
    removeBlob(id: string) {
        this.blobs.delete(id)
    }

    /** 外部 API —— 控制渲染 */
    start() {
        if (this.state.running) return
        this.state.running = true
        this.state.lastFrameMs = 0
        this.loop()
    }
    stop() {
        this.state.running = false
        if (this.rafId) { cancelAnimationFrame(this.rafId); this.rafId = 0 }
    }
    destroy() {
        this.stop()
        // 清理画布
        if (this.ctx) {
            this.ctx.save()
            this.ctx.setTransform(1,0,0,1,0,0)
            this.ctx.clearRect(0,0,this.canvas.width,this.canvas.height)
            this.ctx.restore()
        }
        this.blobs.clear()
    }

    // ================= 内部：渲染循环 =================

    private loop = () => {
        if (!this.state.running) return
        this.rafId = requestAnimationFrame(this.loop)

        const now = performance.now()
        const dt = this.state.lastFrameMs ? (now - this.state.lastFrameMs) : 16.7
        const needCap = this.state.fpsCap > 0
        const minDt = needCap ? (1000 / this.state.fpsCap) : 0
        if (needCap && dt < minDt) return

        this.state.lastFrameMs = now
        this.ensureSize()
        this.render(now)
    }

    private ensureSize() {
        // 用 CSS 像素作为逻辑尺寸，DPR 做物理缩放
        const rect = this.canvas.getBoundingClientRect()
        const dpr = Math.max(1, window.devicePixelRatio || 1)
        const cssW = Math.max(1, Math.floor(rect.width))
        const cssH = Math.max(1, Math.floor(rect.height))

        if (cssW !== this.state.cssW || cssH !== this.state.cssH || dpr !== this.state.dpr) {
            this.state.cssW = cssW
            this.state.cssH = cssH
            this.state.dpr = dpr
            this.canvas.width = Math.max(1, Math.round(cssW * dpr))
            this.canvas.height = Math.max(1, Math.round(cssH * dpr))
        }
    }

    private render(tsMs: number) {
        const c = this.ctx!
        const s = this.state
        const cssW = this.state.cssW
        const cssH = this.state.cssH
        const dpr = this.state.dpr

        // 先回到设备像素坐标，处理背景与清屏
        c.save()
        c.setTransform(1, 0, 0, 1, 0, 0)
        if (s.background) {
            // —— 关键修复：显式铺底，阻断“黑底扁平化”
            c.globalCompositeOperation = 'source-over'
            c.fillStyle = s.background
            c.fillRect(0, 0, this.canvas.width, this.canvas.height)
        } else {
            // 透明清屏
            c.clearRect(0, 0, this.canvas.width, this.canvas.height)
        }
        c.restore()

        // 切回 CSS 像素空间进行绘制
        c.save()
        c.scale(dpr, dpr)
        c.globalCompositeOperation = s.composite
        c.filter = this.state.blurPx > 0 ? `blur(${this.state.blurPx}px)` : 'none'
        c.imageSmoothingEnabled = true

        const t = (tsMs - s.startMs) / 1000 // 秒

        // 视差（占位，按需扩展）
        const parallax = { x: 0, y: 0 }

        // 逐个 blob 绘制
        for (const b of this.blobs.values()) {
            if (b.layers.length === 0) continue

            const dims = { w: cssW, h: cssH, vMax: Math.max(cssW, cssH) }
            // 解析中心与直径
            const center = this.resolveCenter(b.center, dims)
            const baseR = this.resolveDiameter(b.diameter, dims) / 2

            // 漂移
            const dx = (b.drift.ax || 0) * Math.sin(TAU * b.drift.speed * t) + (b.drift.sx || 0) * Math.cos(TAU * b.drift.speed * 0.7 * t)
            const dy = (b.drift.ay || 0) * Math.cos(TAU * b.drift.speed * t) + (b.drift.sy || 0) * Math.sin(TAU * b.drift.speed * 0.7 * t)

            // 呼吸（缩放 + 透明度）
            let scaleMul = 1, opacityMul = 1
            if (b.breath) {
                const phase = (b.breath.phase || 0) * TAU
                const s01 = 0.5 + 0.5 * Math.sin(phase + TAU * b.breath.speed * t)
                scaleMul = lerp(b.breath.scale[0], b.breath.scale[1], s01)
                opacityMul = lerp(b.breath.opacity[0], b.breath.opacity[1], s01)
            }

            // 视差偏移（先简单按比例位移，后续可接 pointer/gyro）
            const px = parallax.x * (b.parallaxScale || 0) * s.parallaxVmax
            const py = parallax.y * (b.parallaxScale || 0) * s.parallaxVmax

            const cx = center.x + dx + px
            const cy = center.y + dy + py
            const r = baseR * scaleMul

            // 逐层径向渐变
            for (const L of b.layers) {
                // 颜色
                const [rr, gg, bb] = L.color
                // 全局透明度乘子
                const A = clamp((b.opacity ?? 1) * opacityMul * s.alpha, 0, 1)

                // 渐变：0(centerAlpha) → 0.5(midAlpha) → 1(edgeAlpha)
                const grad = c.createRadialGradient(cx, cy, 0, cx, cy, r)
                grad.addColorStop(0, `rgba(${rr},${gg},${bb},${clamp(L.centerAlpha * A, 0, 1)})`)
                grad.addColorStop(0.5, `rgba(${rr},${gg},${bb},${clamp(L.midAlpha * A, 0, 1)})`)
                grad.addColorStop(1, `rgba(${rr},${gg},${bb},${clamp(L.edgeAlpha * A, 0, 1)})`)

                c.fillStyle = grad
                c.beginPath()
                c.arc(cx, cy, r, 0, TAU)
                c.fill()
            }
        }

        c.restore()
        // 复位 filter，避免外部误用
        c.filter = 'none'
    }

    // ================= 内部：工具 =================

    private materialize(cfg: Omit<BlobConfig, 'id'> & { id: string }): InternalBlob {
        // 直径像素预缓存（仅存表达式，真正像素每帧按当前 canvas 尺寸解析）
        return {
            ...cfg,
            _diameterPx: 0
        }
    }

    private resolveCenter(center: CenterSpec, dims: { w: number; h: number; vMax: number }): { x: number; y: number } {
        if (typeof center === 'function') {
            const p = center(dims)
            return { x: p.x, y: p.y }
        }
        return {
            x: this.unitToPx(center.x, dims, 'x'),
            y: this.unitToPx(center.y, dims, 'y')
        }
    }

    private resolveDiameter(diameter: string, dims: { w: number; h: number; vMax: number }): number {
        return this.unitToPx(diameter, dims, 'vmax')
    }

    private unitToPx(v: number | string, dims: { w: number; h: number; vMax: number }, axis: 'x' | 'y' | 'vmax'): number {
        if (typeof v === 'number') return v
        const s = String(v).trim()
        if (s.endsWith('px'))   return parseFloat(s)
        if (s.endsWith('%'))    return (axis === 'y' ? dims.h : dims.w) * (parseFloat(s)/100)
        if (s.endsWith('vw'))   return dims.w * (parseFloat(s)/100)
        if (s.endsWith('vh'))   return dims.h * (parseFloat(s)/100)
        if (s.endsWith('vmax')) return dims.vMax * (parseFloat(s)/100)
        const n = parseFloat(s)
        return isNaN(n) ? 0 : n
    }
}

// ================= 小工具函数 =================
function clamp(v: number, a: number, b: number) { return Math.min(b, Math.max(a, v)) }
function lerp(a: number, b: number, t: number) { return a + (b - a) * t }
