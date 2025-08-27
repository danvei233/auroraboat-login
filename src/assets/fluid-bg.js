// fluid-bg.js
/**
 * FluidBackground - 高性能 Canvas 流体背景（支持局部重绘）
 * 用法：
 *   import { FluidBackground } from './fluid-bg.js'
 *   const fb = new FluidBackground(canvas, { alpha: 0.5 })
 *   const id = fb.addBlob({ ... })
 *   fb.start()
 */

/**
 * @typedef {[number, number, number]} RGB
 * @typedef {{ x:number|string, y:number|string }} Center
 * @typedef {{ color:RGB, centerAlpha?:number, midAlpha?:number, edgeAlpha?:number }} Layer
 * @typedef {{
 *   id?: string
 *   diameter: number|string,     // px / '72vmax' / '40vw' / ...
 *   center: Center | ((dims:{w:number,h:number,vMax:number})=>{x:number,y:number})
 *   layers: Layer[]
 *   opacity?: number
 *   parallaxScale?: number
 *   drift?: { ax?:number, ay?:number, sx?:number, sy?:number, speed?:number }  // 轻微漂移
 *   breath?: { scale?:[number,number], opacity?:[number,number], speed?:number, phase?:number } | null
 * }} BlobConfig
 */

const clamp = (v, a, b) => Math.min(b, Math.max(a, v))
const lerp  = (a, b, t) => a + (b - a) * t
const TAU   = Math.PI * 2

// 单位解析：px / % / vw / vh / vmax
function unitToPx(v, dims, axis /* 'x'|'y'|'vmax' */) {
    const { w, h, vMax } = dims
    if (typeof v === 'number') return v
    const s = String(v).trim()
    if (s.endsWith('px')) return parseFloat(s)
    if (s.endsWith('%'))  return (axis === 'y' ? h : w) * (parseFloat(s) / 100)
    if (s.endsWith('vw')) return w * (parseFloat(s) / 100)
    if (s.endsWith('vh')) return h * (parseFloat(s) / 100)
    if (s.endsWith('vmax')) return vMax * (parseFloat(s) / 100)
    const n = parseFloat(s)
    return isNaN(n) ? 0 : n
}

function resolveCenter(center, dims) {
    if (typeof center === 'function') {
        const p = center(dims) || { x: 0, y: 0 }
        return { x: p.x, y: p.y }
    }
    return {
        x: unitToPx(center.x, dims, 'x'),
        y: unitToPx(center.y, dims, 'y'),
    }
}

const Easings = {
    easeInOutQuad: t => (t < 0.5 ? 2*t*t : 1 - Math.pow(-2*t + 2, 2)/2),
}

// ---------- 小工具：脏区 ----------
function inflateRect(r, pad) { return { x:r.x-pad, y:r.y-pad, w:r.w+pad*2, h:r.h+pad*2 } }
function intersect(a,b) { return !(a.x+a.w<=b.x || b.x+b.w<=a.x || a.y+a.h<=b.y || b.y+b.h<=a.y) }
function union(a,b) {
    const x = Math.min(a.x,b.x), y = Math.min(a.y,b.y)
    const r = Math.max(a.x+a.w, b.x+b.w), btm = Math.max(a.y+a.h, b.y+b.h)
    return { x, y, w: r-x, h: btm-y }
}
function mergeRects(rects, tolerance=2) {
    if (rects.length <= 1) return rects
    // 轻量合并：把有交集或近邻（≤tolerance）的矩形并起来
    const out = []
    rects = rects.map(r => inflateRect(r, tolerance))
    while (rects.length) {
        let cur = rects.pop()
        let merged = false
        for (let i=0;i<rects.length;i++){
            if (intersect(cur, rects[i])) {
                cur = union(cur, rects[i])
                rects.splice(i,1)
                merged = true
                i = -1
            }
        }
        out.push(cur)
        if (merged) { /* 继续下一轮 */ }
    }
    // 去掉额外膨胀
    return out.map(r => inflateRect(r, -tolerance))
}

export class FluidBackground {
    /**
     * @param {HTMLCanvasElement} canvas
     * @param {{
     *  alpha?: number,            // 全局不透明度乘子
     *  blurPx?: number,           // 模糊半径（基础像素，内部乘 dpr）
     *  composite?: GlobalCompositeOperation,
     *  parallaxVmax?: number,     // 视差量纲：以 vmax 的比例
     *  fpsCap?: number,           // 0 表示不限制
     *  maxDpr?: number,           // 最多放大到几倍像素
     *  autoStart?: boolean,
     *  // 局部重绘相关
     *  damagePaddingPx?: number,  // 脏区额外安全边距（CSS px）
     *  fullRedrawThreshold?: number, // 当脏区覆盖比例超过该阈值时，退回整屏重绘
     *  maxDirtyRects?: number,    // 脏区数量超过该值时退回整屏重绘
     * }} [opts]
     */
    constructor(canvas, opts = {}) {
        if (!canvas) throw new Error('FluidBackground: canvas is required')
        this.canvas = canvas
        this.ctx = canvas.getContext('2d', { alpha: true, desynchronized: true })

        const isMobile = matchMedia('(max-width: 900px)').matches
        const prefersReduce = matchMedia('(prefers-reduced-motion: reduce)').matches

        this.state = {
            w: 0, h: 0, vMax: 0,
            dpr: clamp((window.devicePixelRatio || 1), 1, opts.maxDpr ?? 2),
            alpha: opts.alpha ?? (isMobile ? 0.44 : 0.50),
            blurPx: opts.blurPx ?? (isMobile ? 32 : 36),
            composite: opts.composite ?? 'source-over',
            parallaxVmax: opts.parallaxVmax ?? (isMobile ? 0.6 : 0.9),
            fpsCap: opts.fpsCap ?? 0,

            damagePaddingPx: opts.damagePaddingPx ?? 12,
            fullRedrawThreshold: clamp(opts.fullRedrawThreshold ?? 0.55, 0.1, 1.0),
            maxDirtyRects: opts.maxDirtyRects ?? 16,

            px: 0, py: 0,   // 当前指针（-1..1）
            tx: 0, ty: 0,   // 目标指针
            lastTs: 0,
            running: false,
            prefersReduce,
        }

        /** @type {Map<string, any>} */
        this._blobs = new Map()
        this._idSeq = 0
        this._raf = 0

        // 分层：静态底图（offscreen）
        this._staticLayer = document.createElement('canvas')
        this._staticCtx = this._staticLayer.getContext('2d')
        this._needRebuildStatic = true

        // 事件
        this._onResize = () => this._resize()
        this._onPointerMove = (e) => {
            const vw = innerWidth || 1
            const vh = innerHeight || 1
            this.state.tx = (e.clientX / vw) * 2 - 1
            this.state.ty = (e.clientY / vh) * 2 - 1
        }
        this._onVisibility = () => {
            if (document.hidden) this.stop()
            else if (!this.state.prefersReduce) this.start()
        }

        window.addEventListener('resize', this._onResize)
        window.addEventListener('pointermove', this._onPointerMove, { passive: true })
        document.addEventListener('visibilitychange', this._onVisibility)

        this._resize()
        if (opts.autoStart ?? !prefersReduce) this.start()
        else this._fullRedraw(performance.now()) // 静态一帧
    }

    /** 销毁并移除事件 */
    destroy() {
        this.stop()
        window.removeEventListener('resize', this._onResize)
        window.removeEventListener('pointermove', this._onPointerMove)
        document.removeEventListener('visibilitychange', this._onVisibility)
        this._blobs.clear()
        this.ctx = null
        this._staticCtx = null
    }

    /** 开始渲染 */
    start() {
        if (this.state.running || !this.ctx) return
        this.state.running = true
        this._raf = requestAnimationFrame((ts) => this._loop(ts))
    }

    /** 停止渲染 */
    stop() {
        this.state.running = false
        cancelAnimationFrame(this._raf)
    }

    setFpsCap(v) { this.state.fpsCap = Math.max(0, v|0) }
    setParallax(v) { this.state.parallaxVmax = Math.max(0, Number(v) || 0) }

    /** 添加一个 blob，返回 id */
    addBlob(cfg /** @type {BlobConfig} */) {
        const id = cfg.id || `b${++this._idSeq}`
        const blob = {
            id,
            diameter: cfg.diameter,
            center: cfg.center,
            layers: cfg.layers || [],
            opacity: cfg.opacity ?? 1,
            parallaxScale: cfg.parallaxScale ?? 1,
            drift: {
                ax: (cfg.drift?.ax ??  2),
                ay: (cfg.drift?.ay ??  1),
                sx: (cfg.drift?.sx ??  1),
                sy: (cfg.drift?.sy ??  1),
                speed: (cfg.drift?.speed ?? 1/40),
            },
            breath: cfg.breath ? {
                scale:   cfg.breath.scale   ?? [1, 1],
                opacity: cfg.breath.opacity ?? [1, 1],
                speed:   cfg.breath.speed   ?? 1/40,
                phase:   cfg.breath.phase   ?? 0,
            } : null,

            // 运行态
            _sprite: null,
            _diamPx: 0,
            _ease: null, // {from:{x,y}, to:{x,y}, t:0..1, dur, ease}
            _lastRect: null,
            _static: false, // 是否归为静态层
        }
        this._blobs.set(id, blob)
        this._rebuildSprite(blob)
        this._classifyBlobStatic(blob)
        this._needRebuildStatic = true
        return id
    }

    /** 更新 blob 的缓动目标位置（会强制转为动态层） */
    easeTo(id, toCenter /** @type {Center} */, duration = 800, easing = 'easeInOutQuad') {
        const b = this._blobs.get(id)
        if (!b) return
        const dims = { w: this.state.w, h: this.state.h, vMax: this.state.vMax }
        const from = resolveCenter(b.center, dims)
        const to = {
            x: unitToPx(toCenter.x, dims, 'x'),
            y: unitToPx(toCenter.y, dims, 'y'),
        }
        b._ease = { from, to, t: 0, dur: Math.max(1, duration), ease: Easings[easing] || Easings.easeInOutQuad }
        if (b._static) { b._static = false; this._needRebuildStatic = true }
    }

    /** 手动重建所有精灵（改变 blur 或 DPR 后可调用） */
    rebuildAll() {
        for (const b of this._blobs.values()) this._rebuildSprite(b)
        this._needRebuildStatic = true
    }

    // ========= 内部：尺寸与渲染 =========

    _resize() {
        const { canvas, state } = this
        const w = innerWidth
        const h = innerHeight
        state.w = w
        state.h = h
        state.vMax = Math.max(w, h)

        canvas.style.width = `${w}px`
        canvas.style.height = `${h}px`
        canvas.width  = Math.round(w * state.dpr)
        canvas.height = Math.round(h * state.dpr)

        // 静态层尺寸同步
        this._staticLayer.width  = canvas.width
        this._staticLayer.height = canvas.height

        for (const b of this._blobs.values()) this._rebuildSprite(b)
        this._needRebuildStatic = true
        this._fullRedraw(performance.now())
    }

    _rebuildSprite(b) {
        const dims = { w: this.state.w, h: this.state.h, vMax: this.state.vMax }
        const dpx = unitToPx(b.diameter, dims, 'vmax')
        b._diamPx = Math.max(32, Math.round(dpx))
        const pad = Math.ceil(this.state.blurPx * this.state.dpr) * 2
        const size = Math.round(b._diamPx * this.state.dpr) + pad

        const off = document.createElement('canvas')
        off.width = size
        off.height = size
        const o = off.getContext('2d')
        const cx = size/2, cy = size/2
        const r  = (b._diamPx * this.state.dpr) / 2

        o.clearRect(0,0,size,size)
        o.globalCompositeOperation = 'lighter'
        o.filter = `blur(${this.state.blurPx * this.state.dpr}px)`

        for (const layer of b.layers) {
            const c = layer.color
            const ca = layer.centerAlpha ?? 0.6
            const ma = layer.midAlpha    ?? ca * 0.44
            const ea = layer.edgeAlpha   ?? 0.0
            const g = o.createRadialGradient(cx, cy, 0, cx, cy, r*0.95)
            g.addColorStop(0.00, `rgba(${c[0]},${c[1]},${c[2]},${ca})`)
            g.addColorStop(0.38, `rgba(${c[0]},${c[1]},${c[2]},${ma})`)
            g.addColorStop(0.74, `rgba(${c[0]},${c[1]},${c[2]},${ea})`)
            g.addColorStop(1.00, `rgba(${c[0]},${c[1]},${c[2]},0)`)
            o.beginPath(); o.arc(cx, cy, r, 0, TAU); o.closePath()
            o.fillStyle = g; o.fill()
        }
        o.filter = 'none'
        o.globalCompositeOperation = 'source-over'
        b._sprite = off
    }

    _classifyBlobStatic(b) {
        const noParallax = !b.parallaxScale || b.parallaxScale === 0
        const noBreath   = !b.breath || (
            (!b.breath.scale || (b.breath.scale[0]===1 && b.breath.scale[1]===1)) &&
            (!b.breath.opacity || (b.breath.opacity[0]===1 && b.breath.opacity[1]===1))
        )
        const d = b.drift || {}
        const noDrift = (!d.speed || d.speed===0) && (!d.ax && !d.ay && !d.sx && !d.sy)
        const staticCandidate = noParallax && noBreath && noDrift && !b._ease
        b._static = !!staticCandidate
    }

    _buildStaticLayer() {
        if (!this._staticCtx) return
        const s = this.state
        const sl = this._staticCtx
        sl.clearRect(0,0,this._staticLayer.width,this._staticLayer.height)

        // 在静态层上按设备像素绘制（不使用 scale），因此要乘 dpr
        for (const b of this._blobs.values()) {
            if (!b._static || !b._sprite) continue
            const base = resolveCenter(b.center, { w:s.w, h:s.h, vMax:s.vMax })
            const sprite = b._sprite
            const sw = sprite.width  / s.dpr
            const sh = sprite.height / s.dpr
            const x = base.x - sw/2
            const y = base.y - sh/2

            sl.globalAlpha = s.alpha * (b.opacity ?? 1)
            // 把 CSS 坐标转设备像素写入静态层
            sl.drawImage(sprite, Math.round(x * s.dpr), Math.round(y * s.dpr), Math.round(sw * s.dpr), Math.round(sh * s.dpr))
        }
        this._needRebuildStatic = false
    }

    _loop(ts) {
        if (!this.state.running) return
        // FPS 限制
        if (this.state.fpsCap > 0) {
            const interval = 1000 / this.state.fpsCap
            if (ts - this.state.lastTs < interval) {
                this._raf = requestAnimationFrame((t)=>this._loop(t))
                return
            }
            this.state.lastTs = ts
        }
        this._step(ts)
        this._raf = requestAnimationFrame((t)=>this._loop(t))
    }

    _fullRedraw(ts) {
        const s = this.state
        if (this._needRebuildStatic) this._buildStaticLayer()

        const c = this.ctx
        if (!c) return

        // 画静态底图
        c.save()
        c.setTransform(1,0,0,1,0,0) // 重置，直接以像素贴图
        c.clearRect(0,0,this.canvas.width,this.canvas.height)
        c.drawImage(this._staticLayer, 0, 0)
        c.restore()

        // 动态层
        c.save()
        c.scale(s.dpr, s.dpr)
        c.globalCompositeOperation = s.composite
        this._drawDynamics(ts, /*limitRect=*/null)
        c.restore()
    }

    _step(ts) {
        const s = this.state
        if (!this.ctx) return
        const tSec = ts / 1000

        // 指针平滑
        s.px = lerp(s.px, s.tx, 0.1)
        s.py = lerp(s.py, s.ty, 0.1)

        if (this._needRebuildStatic) this._buildStaticLayer()

        // 计算脏区：上一帧矩形 + 当前帧矩形
        const dirty = []
        const pad = Math.max(s.damagePaddingPx, (s.blurPx * 1.5)) // 适当扩大，避免模糊边缘闪烁
        const parallaxPx = s.parallaxVmax * (s.vMax / 100)

        for (const b of this._blobs.values()) {
            if (b._static || !b._sprite) continue

            const nowRect = this._blobRect(b, tSec, parallaxPx)
            const infNow  = inflateRect(nowRect, pad)
            if (b._lastRect) {
                dirty.push(inflateRect(b._lastRect, pad))
            }
            dirty.push(infNow)
            b._nextRect = nowRect
        }

        if (dirty.length === 0) {
            // 没有动态对象，保证底图已显示
            if (this._needRebuildStatic) this._fullRedraw(ts)
            return
        }

        // 合并脏区，并决定是否退回整屏重绘
        const merged = mergeRects(dirty, 2)
        const totalArea = s.w * s.h
        const cover = merged.reduce((a,r)=>a + r.w*r.h, 0) / totalArea

        if (merged.length > s.maxDirtyRects || cover > s.fullRedrawThreshold) {
            this._fullRedraw(ts)
        } else {
            this._redrawDirty(ts, merged)
        }

        // 记录本帧矩形
        for (const b of this._blobs.values()) {
            if (b._static || !b._sprite) continue
            b._lastRect = b._nextRect || null
            b._nextRect = null
        }
    }

    _redrawDirty(ts, rects) {
        const s = this.state
        const c = this.ctx
        if (!c) return

        // 1) 用静态底图“修复”脏区
        c.save()
        // 当前主画布通常处于 scale(dpr,dpr) 后的坐标系，我们要在 CSS 像素坐标下指定目标矩形
        c.scale(s.dpr, s.dpr)
        const prevAlpha = c.globalAlpha
        const prevComp  = c.globalCompositeOperation
        c.globalAlpha = 1
        c.globalCompositeOperation = 'source-over'
        for (const r of rects) {
            // 从静态层裁出对应设备像素区域，贴到主画布对应 CSS 区域
            const sx = Math.max(0, Math.floor(r.x * s.dpr))
            const sy = Math.max(0, Math.floor(r.y * s.dpr))
            const sw = Math.ceil(r.w * s.dpr)
            const sh = Math.ceil(r.h * s.dpr)
            c.drawImage(this._staticLayer, sx, sy, sw, sh, r.x, r.y, r.w, r.h)
        }
        c.globalAlpha = prevAlpha
        c.globalCompositeOperation = prevComp
        c.restore()

        // 2) 在脏区范围内只重绘与之相交的动态 blob
        c.save()
        c.scale(s.dpr, s.dpr)
        c.globalCompositeOperation = s.composite
        this._drawDynamics(ts, rects)
        c.restore()
    }

    _drawDynamics(ts, limitRects /* null | Array<Rect> */) {
        const s = this.state
        const tSec = ts / 1000
        const parallaxPx = s.parallaxVmax * (s.vMax / 100)
        const c = this.ctx

        for (const b of this._blobs.values()) {
            if (b._static || !b._sprite) continue

            // 计算当前帧中心、缩放、透明度
            const st = this._blobStateNow(b, tSec, parallaxPx)
            const sprite = b._sprite
            const sw = (sprite.width  / s.dpr) * st.scaleMul
            const sh = (sprite.height / s.dpr) * st.scaleMul
            const x = st.cx - sw/2
            const y = st.cy - sh/2
            const rect = { x, y, w: sw, h: sh }

            if (limitRects && !limitRects.some(r => intersect(r, rect))) continue

            c.globalAlpha = s.alpha * (b.opacity ?? 1) * st.alphaMul
            c.drawImage(sprite, x, y, sw, sh)
        }
    }

    _blobRect(b, tSec, parallaxPx) {
        const s = this.state
        const st = this._blobStateNow(b, tSec, parallaxPx)
        const sprite = b._sprite
        const sw = (sprite.width  / s.dpr) * st.scaleMul
        const sh = (sprite.height / s.dpr) * st.scaleMul
        return { x: st.cx - sw/2, y: st.cy - sh/2, w: sw, h: sh }
    }

    _blobStateNow(b, tSec, parallaxPx) {
        const s = this.state
        const base = resolveCenter(b.center, { w:s.w, h:s.h, vMax:s.vMax })

        // 缓动
        let cx = base.x, cy = base.y
        if (b._ease) {
            b._ease.t = clamp(b._ease.t + (16 / b._ease.dur), 0, 1) // ~60fps 的近似
            const e = b._ease.ease(b._ease.t)
            cx = lerp(b._ease.from.x, b._ease.to.x, e)
            cy = lerp(b._ease.from.y, b._ease.to.y, e)
            if (b._ease.t >= 1) { b._ease = null; this._classifyBlobStatic(b); this._needRebuildStatic = this._needRebuildStatic || b._static }
        }

        // 视差 + 轻微漂移
        const dx = s.px * parallaxPx * (b.parallaxScale ?? 1)
        const dy = s.py * parallaxPx * (b.parallaxScale ?? 1)
        const driftX = Math.sin(tSec * TAU * b.drift.speed + 1.3) * b.drift.ax
            + Math.sin(tSec * TAU * b.drift.speed * 0.5 + 0.7) * b.drift.sx
        const driftY = Math.cos(tSec * TAU * b.drift.speed + 0.9) * b.drift.ay
            + Math.cos(tSec * TAU * b.drift.speed * 0.6 + 0.4) * b.drift.sy

        // 呼吸（缩放 / 透明度）
        let scaleMul = 1
        let alphaMul = 1
        if (b.breath) {
            const p = Math.sin(TAU * (b.breath.speed * tSec + (b.breath.phase||0)))
            if (b.breath.scale)   scaleMul = lerp(b.breath.scale[0],   b.breath.scale[1],   (p+1)/2)
            if (b.breath.opacity) alphaMul = lerp(b.breath.opacity[0], b.breath.opacity[1], (p+1)/2)
        }

        return { cx: cx + dx + driftX, cy: cy + dy + driftY, scaleMul, alphaMul }
    }
}
