import type { Span, SpanGroup, Track, TrackTimelineOptions, VisibleTrackRange, Interval } from './types.js';
import type { RangeSet } from '../../prepare/computations/coordinates.js';
import { layoutSpans } from './layout.js';
import { SpanIndex } from './span-index.js';
import { SpanLabels, SPAN_LABEL_FONT } from './labels.js';

type TrackImage = {
    canvas: HTMLCanvasElement;
    context: CanvasRenderingContext2D;
    spans: Span[];
    positions: number[];
};

type TimelineGroup = SpanGroup & {
    tracks: Track[];
    layout: ReturnType<typeof layoutSpans> | null;
    complete: boolean;
    published: boolean;
    startY: number;
    endY: number;
};

const LAYOUT_BUDGET = 12;

// Conversion factors to convert FROM each unit TO milliseconds
const UNIT_TO_MS = {
    s: 1000,
    ms: 1,
    us: 0.001,
    ns: 0.000001
} as const;

const LAYOUT = {
    RULER_HEIGHT: 30,
    MINIMAP_HEIGHT: 10,
    TRACK_HEIGHT: 15,
    TRACK_GAP: 1,
    TRACK_PADDING: 1,
    GROUP_TITLE_HEIGHT: 24
} as const;

const COLORS = {
    BACKGROUND: '#242424',
    TRACK_BG: '#2a2a2a',
    BORDER: '#444',
    TEXT_PRIMARY: '#e0e0e0',
    TEXT_SECONDARY: '#aaa',
    SELECTED_FILL: '#0098fb1a',
    SELECTED_BORDER: '#268fea',
    HOVER_FILL: 'rgba(255, 255, 0, 0.3)',
    HOVER_BORDER: 'rgba(255, 255, 0, 0.9)',
    VIEWPORT: 'rgba(100, 100, 100, 0.5)'
} as const;

export class TrackTimeline {
    private readonly container: HTMLElement;
    private readonly baseCanvas: HTMLCanvasElement;
    private readonly overlayCanvas: HTMLCanvasElement;
    private readonly baseCtx: CanvasRenderingContext2D;
    private readonly overlayCtx: CanvasRenderingContext2D;
    // private readonly tooltip: HTMLElement;
    private readonly resizeObserver: ResizeObserver;

    private options: Required<TrackTimelineOptions>;
    private tracks: Track[] = [];
    private trackOffsets: number[] = [];
    private contentHeight = 0;
    private trackImages = new Map<Track, TrackImage>();
    private trackIndexes = new WeakMap<Span[], SpanIndex>();
    private labels = new SpanLabels();
    private trackImageWidth = 0;
    private trackImageScale = 0;
    private trackImageOffset = 0;
    private trackImageDpr = 0;
    private groups: TimelineGroup[] = [];
    private visibleGroups: TimelineGroup[] = [];
    private intervals: Interval[] = [];
    private minX = 0;
    private maxX = 1000;
    private pxPerMs = 1;
    private offsetMs = 0;
    private scrollY = 0;
    private width = 0;
    private height = 0;
    private dpr = window.devicePixelRatio || 1;

    // Interaction state
    private hoveredSpan: Span | null = null;
    private pointerEvent: PointerEvent | null = null;
    private selection: RangeSet | null = null;
    private isDragging = false;
    private dragStartX = 0;
    private dragStartY = 0;
    private lastPointerX = 0;
    private lastPointerY = 0;
    #renderScheduled: number | null = null;
    #shouldResize = true;
    #layoutGroupIndex = 0;
    #layoutScheduled: ReturnType<typeof setTimeout> | null = null;
    #destroyed = false;
    #events = new AbortController();

    // Wheel gesture tracking
    private lastWheelAction: 'zoom' | 'pan' | 'vscroll' | null = null;
    private lastWheelTime = 0;
    private lastWheelDelta = 0;

    constructor(container: HTMLElement, options: TrackTimelineOptions = {}) {
        this.container = container;
        this.options = {
            spans: [],
            ruler: 'relative',
            unit: 'ms',
            minX: null!,
            maxX: null!,
            onHover: null!,
            onClick: null!,
            groups: false,
            intervals: [],
            ...options
        };

        this.baseCanvas = container.querySelector('.view-track-timeline__canvas') as HTMLCanvasElement;
        this.overlayCanvas = container.querySelector('.view-track-timeline__overlay') as HTMLCanvasElement;

        if (!this.baseCanvas || !this.overlayCanvas) {
            throw new Error('Required canvas elements not found');
        }

        this.baseCtx = this.baseCanvas.getContext('2d', { alpha: true })!;
        this.overlayCtx = this.overlayCanvas.getContext('2d', { alpha: true })!;

        this.resizeObserver = new ResizeObserver(() => {
            this.#shouldResize = true;
            this.#scheduleRender();
        });
        this.resizeObserver.observe(this.container);

        this.setupEventListeners();
        this.setSpans(this.options.spans);
        this.setIntervals(this.options.intervals);
    }

    public setSpans(spans: Span[] | SpanGroup[], useGroups?: boolean): void {
        if (this.#layoutScheduled !== null) {
            clearTimeout(this.#layoutScheduled);
            this.#layoutScheduled = null;
        }

        for (const group of this.groups) {
            group.layout?.return();
        }

        if (useGroups !== undefined) {
            this.options.groups = useGroups;
        }

        const groups = this.options.groups
            ? spans as SpanGroup[]
            : [{ name: '', spans: spans as Span[] }];

        this.groups = groups.map(group => ({
            name: group.name || 'Unnamed Group',
            collapsed: group.collapsed || false,
            spans: group.spans,
            intervals: this.sortIntervals(group.intervals || []),
            tracks: [],
            layout: null,
            complete: false,
            published: false,
            startY: 0,
            endY: 0
        }));

        this.options.spans = spans;
        this.trackImages.clear();
        this.trackIndexes = new WeakMap();
        this.labels.clear();
        this.#layoutGroupIndex = 0;

        if (this.hoveredSpan && this.pointerEvent) {
            this.options.onHover?.(null, this.pointerEvent);
        }

        this.hoveredSpan = null;
        this.computeBounds();
        this.layoutTracks();
        this.#scheduleLayout();
        this.#scheduleRender();
    }

    public setIntervals(intervals: Interval[]): void {
        this.intervals = this.sortIntervals(intervals || []);
        this.#scheduleRender();
    }

    public setSelection(selection: RangeSet | null): void {
        this.selection = selection;
        this.#scheduleRender();
    }

    public setBounds(minX?: number, maxX?: number): void {
        if (this.minX === minX && this.maxX === maxX) {
            return;
        }

        if (minX !== undefined) {
            this.minX = minX;
        }

        if (maxX !== undefined) {
            this.maxX = maxX;
        }

        this.resetView();
        this.#scheduleRender();
    }

    public destroy(): void {
        this.#destroyed = true;
        this.#events.abort();
        this.trackImages.clear();
        this.trackIndexes = new WeakMap();
        this.labels.clear();
        this.resizeObserver.disconnect();

        if (this.#layoutScheduled !== null) {
            clearTimeout(this.#layoutScheduled);
            this.#layoutScheduled = null;
        }

        for (const group of this.groups) {
            group.layout?.return();
            group.layout = null;
        }

        if (this.#renderScheduled !== null) {
            cancelAnimationFrame(this.#renderScheduled);
            this.#renderScheduled = null;
        }
    }

    private sortIntervals(intervals: Interval[]): Interval[] {
        return [...intervals].sort((a, b) => {
            const zIndexA = a.zIndex ?? 0;
            const zIndexB = b.zIndex ?? 0;

            if (zIndexA !== zIndexB) {
                return zIndexA - zIndexB;
            }

            const startA = 'offset' in a ? a.offset : a.start;
            const startB = 'offset' in b ? b.offset : b.start;

            return startA - startB;
        });
    }

    private setupEventListeners(): void {
        const { signal } = this.#events;

        this.overlayCanvas.addEventListener('wheel', (event) => this.onWheel(event), { passive: false, signal });
        this.overlayCanvas.addEventListener('pointermove', (event) => this.onPointerMove(event), { signal });
        this.overlayCanvas.addEventListener('pointerdown', (event) => this.onPointerDown(event), { signal });
        this.overlayCanvas.addEventListener('pointerup', (event) => this.onPointerUp(event), { signal });
        this.overlayCanvas.addEventListener('pointerleave', (event) => this.onPointerLeave(event), { signal });
        document.fonts?.addEventListener('loadingdone', () => {
            this.labels.clear();
            this.trackImages.clear();
            this.#scheduleRender();
        }, { signal });
    }

    private resize(): void {
        const prevWidth = this.width;
        const rect = this.container.getBoundingClientRect();

        this.width = rect.width;
        this.height = rect.height;
        this.dpr = window.devicePixelRatio || 1;

        for (const canvas of [this.baseCanvas, this.overlayCanvas]) {
            canvas.width = this.width * this.dpr;
            canvas.height = this.height * this.dpr;
            canvas.style.width = `${this.width}px`;
            canvas.style.height = `${this.height}px`;
        }

        this.baseCtx.scale(this.dpr, this.dpr);
        this.overlayCtx.scale(this.dpr, this.dpr);

        if (prevWidth > 0 && this.width) {
            this.pxPerMs *= this.width / prevWidth;
        } else {
            this.resetView(false);
        }

        this.handleVerticalScroll(0);
    }

    private computeBounds(): void {
        const explicitMin = Number.isFinite(this.options.minX);
        const explicitMax = Number.isFinite(this.options.maxX);
        let minX = explicitMin ? this.options.minX : Infinity;
        let maxX = explicitMax ? this.options.maxX : -Infinity;

        if (!explicitMin || !explicitMax) {
            for (const group of this.groups) {
                for (const span of group.spans) {
                    if (!explicitMin) {
                        minX = Math.min(minX, span.start);
                    }

                    if (!explicitMax) {
                        maxX = Math.max(maxX, span.end);
                    }
                }
            }
        }

        if (!Number.isFinite(minX)) {
            minX = Number.isFinite(maxX) ? maxX - 1 : 0;
        }

        if (!Number.isFinite(maxX) || maxX <= minX) {
            maxX = minX + Math.max(1, Math.abs(minX) * Number.EPSILON);
        }

        this.setBounds(minX, maxX);
    }

    private layoutTracks(): void {
        let offset = 0;

        this.tracks = [];
        this.trackOffsets = [];
        this.visibleGroups = [];

        for (const group of this.groups) {
            if (!group.published && !group.collapsed && !group.complete) {
                break;
            }

            group.published = true;
            this.visibleGroups.push(group);
            group.startY = offset;

            if (this.options.groups) {
                this.trackOffsets.push(offset);
                this.tracks.push({ isGroupTitle: true, group, spans: [] });
                offset += LAYOUT.GROUP_TITLE_HEIGHT + LAYOUT.TRACK_GAP;
            }

            if (!group.collapsed && group.complete) {
                for (const track of group.tracks) {
                    this.trackOffsets.push(offset);
                    this.tracks.push(track);
                    offset += LAYOUT.TRACK_HEIGHT + LAYOUT.TRACK_GAP;
                }
            }

            group.endY = Math.max(group.startY, offset - LAYOUT.TRACK_GAP);
        }

        this.contentHeight = offset;
        this.handleVerticalScroll(0);
    }

    private advanceLayout(): void {
        const deadline = performance.now() + LAYOUT_BUDGET;
        let changed = false;

        while (this.#layoutGroupIndex < this.groups.length) {
            const group = this.groups[this.#layoutGroupIndex];

            if (group.collapsed || group.complete) {
                this.#layoutGroupIndex++;
                continue;
            }

            group.layout ??= layoutSpans(group.spans);
            const result = group.layout.next();

            if (result.done) {
                group.complete = true;
                group.layout = null;
                this.#layoutGroupIndex++;
                changed = true;
            }

            if (result.value) {
                group.tracks.push({
                    isGroupTitle: false,
                    group: this.options.groups ? group : null,
                    spans: result.value
                });
            }

            if (performance.now() >= deadline) {
                break;
            }
        }

        if (changed) {
            this.layoutTracks();
        }
    }

    private resetView(resetViewport = true): void {
        const range = this.maxX - this.minX;
        this.pxPerMs = this.width / range;

        if (resetViewport) {
            this.offsetMs = this.minX;
            this.scrollY = 0;
        }

        this.#scheduleRender();
    }

    private msToX(ms: number): number {
        return (ms - this.offsetMs) * this.pxPerMs;
    }

    private xToMs(x: number): number {
        return x / this.pxPerMs + this.offsetMs;
    }

    private getVisibleTrackRange(): VisibleTrackRange {
        const start = this.findTrackAtOffset(this.scrollY);
        const visibleEnd = this.scrollY + Math.max(0, this.height - LAYOUT.RULER_HEIGHT - LAYOUT.MINIMAP_HEIGHT);
        let lower = start;
        let upper = this.tracks.length;

        while (lower < upper) {
            const middle = (lower + upper) >>> 1;

            if (this.trackOffsets[middle] < visibleEnd) {
                lower = middle + 1;
            } else {
                upper = middle;
            }
        }

        return { start, end: lower };
    }

    private findTrackAtOffset(offset: number): number {
        let lower = 0;
        let upper = this.tracks.length;

        while (lower < upper) {
            const middle = (lower + upper) >>> 1;

            if (this.trackOffsets[middle] + this.getTrackHeight(middle) <= offset) {
                lower = middle + 1;
            } else {
                upper = middle;
            }
        }

        return lower;
    }

    private getTrackHeight(trackIdx: number): number {
        const track = this.tracks[trackIdx];
        return track?.isGroupTitle ? LAYOUT.GROUP_TITLE_HEIGHT : LAYOUT.TRACK_HEIGHT;
    }

    private getTrackStartY(trackIdx: number): number {
        return this.trackOffsets[trackIdx];
    }

    private getTrackY(trackIdx: number): number {
        return LAYOUT.RULER_HEIGHT + this.getTrackStartY(trackIdx) - this.scrollY;
    }

    #scheduleLayout() {
        if (!this.#destroyed && this.#layoutScheduled === null && this.#layoutGroupIndex < this.groups.length) {
            this.#layoutScheduled = setTimeout(() => {
                this.#layoutScheduled = null;
                this.advanceLayout();
                this.#scheduleLayout();
            }, 0);
        }
    }

    #scheduleRender() {
        if (!this.#destroyed && this.#renderScheduled === null) {
            this.#renderScheduled = requestAnimationFrame(() => {
                this.render();
                this.#renderScheduled = null;
            });
        }
    }

    private render(): void {
        if (this.#shouldResize) {
            this.#shouldResize = false;
            this.resize();
        }

        this.renderBase();

        if (this.pointerEvent && !this.isDragging) {
            this.onPointerMove(this.pointerEvent);
        }

        this.renderOverlay();
    }

    private renderBase(): void {
        const ctx = this.baseCtx;
        const imagesChanged = this.trackImageWidth !== this.width ||
            this.trackImageScale !== this.pxPerMs ||
            this.trackImageOffset !== this.offsetMs ||
            this.trackImageDpr !== this.dpr;
        const imageSizeChanged = this.trackImageWidth !== this.width || this.trackImageDpr !== this.dpr;

        if (imagesChanged) {
            this.trackImageWidth = this.width;
            this.trackImageScale = this.pxPerMs;
            this.trackImageOffset = this.offsetMs;
            this.trackImageDpr = this.dpr;
        }

        ctx.fillStyle = COLORS.BACKGROUND;
        ctx.fillRect(0, 0, this.width, this.height);
        // ctx.clearRect(0, 0, this.width, this.height);

        // Render global intervals first (under everything)
        this.renderIntervals(ctx, this.intervals, 0, this.height - LAYOUT.MINIMAP_HEIGHT);
        this.renderRuler(ctx);

        const trackRange = this.getVisibleTrackRange();
        const contentY = LAYOUT.RULER_HEIGHT;

        ctx.save();
        ctx.beginPath();
        ctx.rect(0, contentY, this.width, this.height - contentY - LAYOUT.MINIMAP_HEIGHT);
        ctx.clip();

        if (this.options.groups) {
            for (const group of this.visibleGroups) {
                const top = contentY + group.startY - this.scrollY;
                const bottom = contentY + group.endY - this.scrollY;

                if (bottom <= contentY || top >= this.height - LAYOUT.MINIMAP_HEIGHT) {
                    continue;
                }

                this.renderGroupTitleBackground(ctx, top);
                this.renderIntervals(ctx, group.intervals || [], top, bottom);
                this.renderGroupTitleForeground(ctx, top, group);
            }
        }

        const visibleTracks = new Set<Track>();

        for (let index = trackRange.start; index < trackRange.end; index++) {
            const track = this.tracks[index];

            if (!track.isGroupTitle) {
                let image = this.trackImages.get(track);
                const newImage = !image;

                if (!image) {
                    const canvas = document.createElement('canvas');

                    image = { canvas, context: canvas.getContext('2d')!, spans: [], positions: [] };
                    this.trackImages.set(track, image);
                }

                if (newImage || imagesChanged) {
                    if (newImage || imageSizeChanged) {
                        image.canvas.width = Math.ceil(this.width * this.dpr);
                        image.canvas.height = Math.ceil(LAYOUT.TRACK_HEIGHT * this.dpr);
                        image.context.scale(this.dpr, this.dpr);
                    } else {
                        image.context.clearRect(0, 0, this.width, LAYOUT.TRACK_HEIGHT);
                    }

                    this.renderTrack(image.context, track.spans, 0, image);
                }

                visibleTracks.add(track);

                if (image.canvas.width > 0) {
                    ctx.drawImage(image.canvas,
                        0, 0, this.width * this.dpr, LAYOUT.TRACK_HEIGHT * this.dpr,
                        0, this.getTrackY(index), this.width, LAYOUT.TRACK_HEIGHT);
                }
            }
        }

        for (const track of this.trackImages.keys()) {
            if (!visibleTracks.has(track)) {
                this.trackImages.delete(track);
            }
        }

        ctx.restore();
        this.renderMinimap(ctx);
    }

    private renderIntervals(ctx: CanvasRenderingContext2D, intervals: Interval[], topY: number, bottomY: number): void {
        const viewStart = this.offsetMs;
        const viewEnd = this.offsetMs + this.width / this.pxPerMs;
        const height = bottomY - topY;

        if (height <= 0) {
            return;
        }

        for (const interval of intervals) {
            const isLine = 'offset' in interval;
            const start = isLine ? interval.offset : interval.start;
            const end = isLine ? interval.offset : interval.end;

            // Skip intervals outside viewport
            if (end < viewStart || start > viewEnd) {
                continue;
            }

            const x1 = this.msToX(start);
            const x2 = this.msToX(end);
            const width = Math.max(1, x2 - x1);

            if (isLine || start === end) {
                // Draw as line
                const color = interval.color || '#888';
                ctx.strokeStyle = color;
                ctx.lineWidth = 1;
                ctx.beginPath();
                ctx.moveTo(x1 + 0.5, topY);
                ctx.lineTo(x1 + 0.5, bottomY);
                ctx.stroke();
            } else {
                // Draw as span
                const intervalSpan = interval as { start: number; end: number; color?: string; border?: string };

                if (intervalSpan.color) {
                    ctx.fillStyle = intervalSpan.color;
                    ctx.fillRect(x1, topY, width, height);
                }

                if (intervalSpan.border) {
                    ctx.strokeStyle = intervalSpan.border;
                    ctx.lineWidth = 1;
                    ctx.beginPath();
                    ctx.moveTo(x1, topY);
                    ctx.lineTo(x1, bottomY);
                    ctx.moveTo(x2, topY);
                    ctx.lineTo(x2, bottomY);
                    ctx.stroke();
                }
            }
        }
    }

    private renderRuler(ctx: CanvasRenderingContext2D): void {
        const rulerHeight = LAYOUT.RULER_HEIGHT;

        ctx.fillStyle = COLORS.BACKGROUND + '40';
        ctx.fillRect(0, 0, this.width, rulerHeight);

        ctx.strokeStyle = COLORS.BORDER;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, rulerHeight - 0.5);
        ctx.lineTo(this.width, rulerHeight - 0.5);
        ctx.stroke();

        const tickBase = this.options.ruler === 'absolute' ? 0 : this.minX;
        const viewStart = this.offsetMs;
        const viewEnd = this.offsetMs + this.width / this.pxPerMs;
        const range = viewEnd - viewStart;

        const tickInterval = this.getNiceInterval(range * 80 / this.width);
        const startTick = tickBase + Math.ceil((viewStart - tickBase) / tickInterval) * tickInterval;

        ctx.fillStyle = COLORS.TEXT_SECONDARY;
        ctx.font = '11px system-ui';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';

        for (let tick = startTick; tick <= viewEnd; tick += tickInterval) {
            const x = this.msToX(tick);
            const label = this.formatTime(tick - tickBase, tickInterval, range);

            ctx.strokeStyle = COLORS.BORDER;
            ctx.beginPath();
            ctx.moveTo(x, rulerHeight - 8);
            ctx.lineTo(x, rulerHeight);
            ctx.stroke();

            ctx.fillText(label, x, rulerHeight / 2 - 2);
        }
    }

    private getNiceInterval(rawInterval: number): number {
        const magnitude = Math.pow(10, Math.floor(Math.log10(rawInterval)));
        const normalized = rawInterval / magnitude;
        let nice: number;

        if (normalized < 1.5) {
            nice = 1;
        } else if (normalized < 3) {
            nice = 2;
        } else if (normalized < 7) {
            nice = 5;
        } else {
            nice = 10;
        }

        return nice * magnitude;
    }

    private formatTime(ms: number, tickInterval: number, range: number): string {
        const interval = tickInterval || Math.abs(ms) / 10;
        const displayRange = range || Math.abs(ms) * 2;

        // Convert from base unit to milliseconds for threshold comparison
        const baseToMs = UNIT_TO_MS[this.options.unit];
        const displayRangeInMs = displayRange * baseToMs;

        let value: number;
        let suffix: string;
        let intervalInUnit: number;
        let decimals: number;

        if (displayRangeInMs >= 2000) {
            // Display in seconds
            value = ms * baseToMs / 1000;
            suffix = 's';
            intervalInUnit = interval * baseToMs / 1000;
        } else if (displayRangeInMs >= 2) {
            // Display in milliseconds
            value = ms * baseToMs;
            suffix = 'ms';
            intervalInUnit = interval * baseToMs;
        } else if (displayRangeInMs >= 0.002) {
            // Display in microseconds
            value = ms * baseToMs * 1000;
            suffix = 'us';
            intervalInUnit = interval * baseToMs * 1000;
        } else {
            // Display in nanoseconds
            value = ms * baseToMs * 1000000;
            suffix = 'ns';
            intervalInUnit = interval * baseToMs * 1000000;
        }

        if (intervalInUnit >= 10) {
            decimals = 0;
        } else if (intervalInUnit >= 1) {
            decimals = 1;
        } else if (intervalInUnit >= 0.1) {
            decimals = 2;
        } else if (intervalInUnit >= 0.01) {
            decimals = 3;
        } else {
            decimals = 4;
        }

        return value.toFixed(decimals) + suffix;
    }

    private renderGroupTitleBackground(ctx: CanvasRenderingContext2D, trackY: number): void {
        const height = LAYOUT.GROUP_TITLE_HEIGHT;

        ctx.fillStyle = COLORS.TRACK_BG;
        ctx.fillRect(0, trackY, this.width, height);

        ctx.strokeStyle = COLORS.BORDER;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, trackY + height - 0.5);
        ctx.lineTo(this.width, trackY + height - 0.5);
        ctx.stroke();
    }

    private renderGroupTitleForeground(ctx: CanvasRenderingContext2D, trackY: number, group: SpanGroup): void {
        const height = LAYOUT.GROUP_TITLE_HEIGHT;
        const iconX = 8;
        const iconY = trackY + height / 2;
        const iconSize = 8;

        ctx.fillStyle = COLORS.TEXT_SECONDARY;
        ctx.beginPath();
        if (group.collapsed) {
            ctx.moveTo(iconX, iconY - iconSize / 2);
            ctx.lineTo(iconX + iconSize, iconY);
            ctx.lineTo(iconX, iconY + iconSize / 2);
        } else {
            ctx.moveTo(iconX, iconY - iconSize / 2);
            ctx.lineTo(iconX + iconSize, iconY - iconSize / 2);
            ctx.lineTo(iconX + iconSize / 2, iconY + iconSize / 2);
        }
        ctx.closePath();
        ctx.fill();

        ctx.fillStyle = COLORS.TEXT_PRIMARY;
        ctx.font = '12px system-ui';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(group.name, iconX + iconSize + 8, iconY);
    }

    private renderTrack(
        ctx: CanvasRenderingContext2D,
        track: Span[],
        trackY: number,
        image: Pick<TrackImage, 'spans' | 'positions'> = { spans: [], positions: [] }
    ) {
        const viewStart = this.offsetMs;
        const viewEnd = this.offsetMs + this.width / this.pxPerMs;
        const { spans, positions } = image;
        let rightEdge = 0;
        let index = this.trackIndexes.get(track);

        spans.length = 0;
        positions.length = 0;
        ctx.font = SPAN_LABEL_FONT;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';

        if (!index) {
            index = new SpanIndex(track);
            this.trackIndexes.set(track, index);
        }

        index.forEachVisible(viewStart - 1 / this.pxPerMs, viewEnd, 1 / this.pxPerMs, (span, start, end) => {
            const startX = this.msToX(start);
            const endX = this.msToX(end);
            const small = endX - startX < 1;
            const left = small ? Math.floor(startX * this.dpr) / this.dpr : startX;
            const right = Math.min(this.width, small ? left + 1 : endX);
            const visibleLeft = Math.max(0, rightEdge, left);

            if (right <= visibleLeft) {
                return;
            }

            this.renderSpan(ctx, span, trackY, visibleLeft, right - visibleLeft);
            spans.push(span);
            positions.push(visibleLeft, right);
            rightEdge = right;
        });

        return image;
    }

    private renderSpan(ctx: CanvasRenderingContext2D, span: Span, trackY: number, x1: number, width: number): void {
        const height = LAYOUT.TRACK_HEIGHT;

        ctx.fillStyle = span.color || this.getDefaultColor(span);
        ctx.fillRect(x1, trackY, width, height);

        const maxWidth = width - (LAYOUT.TRACK_PADDING + 2) * 2;
        const displayText = span.text ? this.labels.fit(ctx, span.text, maxWidth) : '';

        if (displayText) {
            ctx.save();
            ctx.beginPath();
            ctx.rect(x1 + LAYOUT.TRACK_PADDING, trackY, width - LAYOUT.TRACK_PADDING * 2, height);
            ctx.clip();
            ctx.fillStyle = '#fff';
            ctx.fillText(displayText, x1 + LAYOUT.TRACK_PADDING + 2, trackY + height / 2 + 1);
            ctx.restore();
        }
    }

    private getDefaultColor(span: Span): string {
        let hash = 0;
        const text = span.text || '';

        for (let i = 0; i < text.length; i++) {
            hash = ((hash << 5) - hash) + text.charCodeAt(i);
            hash = hash & hash;
        }

        const hue = Math.abs(hash) % 360;

        return `hsl(${hue}, 30%, 40%, 80%)`;
    }

    private renderMinimap(ctx: CanvasRenderingContext2D): void {
        const minimapY = this.height - LAYOUT.MINIMAP_HEIGHT;
        const minimapHeight = LAYOUT.MINIMAP_HEIGHT;

        ctx.fillStyle = COLORS.BACKGROUND;
        ctx.fillRect(0, minimapY, this.width, minimapHeight);

        const fullRange = this.maxX - this.minX;
        const minimapPxPerMs = this.width / fullRange;
        const msToMinimapX = (ms: number) => (ms - this.minX) * minimapPxPerMs;

        const viewStart = this.offsetMs;
        const viewEnd = this.offsetMs + this.width / this.pxPerMs;
        const windowX1 = msToMinimapX(viewStart);
        const windowX2 = msToMinimapX(viewEnd);

        ctx.fillStyle = COLORS.VIEWPORT;
        ctx.fillRect(windowX1, minimapY, windowX2 - windowX1, minimapHeight);

        for (const { start, end } of this.selection || []) {
            const x1 = msToMinimapX(start);
            const x2 = msToMinimapX(end);
            const width = Math.max(2, x2 - x1);

            ctx.fillStyle = COLORS.SELECTED_FILL;
            ctx.fillRect(x1, minimapY, width, minimapHeight);

            ctx.strokeStyle = COLORS.SELECTED_BORDER;
            ctx.lineWidth = 1;
            ctx.strokeRect(x1, minimapY + 2, width, minimapHeight - 4);
        }
    }

    private renderOverlay(): void {
        const ctx = this.overlayCtx;
        ctx.clearRect(0, 0, this.width, this.height);

        for (const { start, end } of this.selection || []) {
            const startX = this.msToX(start);
            const endX = this.msToX(end);

            ctx.fillStyle = COLORS.SELECTED_FILL;
            ctx.fillRect(startX, 0, endX - startX, this.height - LAYOUT.MINIMAP_HEIGHT);
            ctx.strokeStyle = COLORS.SELECTED_BORDER;
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(startX, 0);
            ctx.lineTo(startX, this.height - LAYOUT.MINIMAP_HEIGHT);
            ctx.moveTo(endX, 0);
            ctx.lineTo(endX, this.height - LAYOUT.MINIMAP_HEIGHT);
            ctx.stroke();
        }

        const contentY = LAYOUT.RULER_HEIGHT;
        const contentHeight = this.height - LAYOUT.RULER_HEIGHT - LAYOUT.MINIMAP_HEIGHT;

        ctx.save();
        ctx.beginPath();
        ctx.rect(0, contentY, this.width, contentHeight);
        ctx.clip();

        if (this.hoveredSpan) {
            const trackIdx = this.findTrackForSpan(this.hoveredSpan);

            if (trackIdx !== -1) {
                const trackY = this.getTrackY(trackIdx);

                this.renderSpanHighlight(ctx, this.hoveredSpan, trackY, COLORS.HOVER_FILL, COLORS.HOVER_BORDER);
            }
        }

        ctx.restore();
    }

    private renderSpanHighlight(ctx: CanvasRenderingContext2D, span: Span, trackY: number, color: string, borderColor: string): void {
        const trackIdx = this.findTrackForSpan(span);
        const image = this.trackImages.get(this.tracks[trackIdx]);
        const position = image?.spans.indexOf(span) ?? -1;

        if (!image || position === -1) {
            return;
        }

        const x1 = image.positions[position * 2];
        const width = image.positions[position * 2 + 1] - x1;
        const height = LAYOUT.TRACK_HEIGHT;

        ctx.fillStyle = color;
        ctx.fillRect(x1, trackY, width, height);

        ctx.strokeStyle = borderColor;
        ctx.lineWidth = 1;
        ctx.strokeRect(x1 + 0.5, trackY + 0.5, Math.max(0, width - 1), height - 1);
    }

    private findTrackForSpan(span: Span): number {
        return this.tracks.findIndex(track => this.trackImages.get(track)?.spans.includes(span));
    }

    private onWheel(e: WheelEvent): void {
        e.preventDefault();

        const rect = this.overlayCanvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const now = Date.now();
        const timeSinceLastWheel = now - this.lastWheelTime;
        const isPrimaryVertical = Math.abs(e.deltaY) >= Math.abs(e.deltaX);
        const totalDelta = Math.abs(e.deltaY) + Math.abs(e.deltaX);
        const isNewGesture = timeSinceLastWheel > 100 || totalDelta > this.lastWheelDelta * 1.5;

        let intendedAction: 'zoom' | 'pan' | 'vscroll';

        if (e.shiftKey && isPrimaryVertical) {
            intendedAction = 'vscroll';
        } else if (!isPrimaryVertical) {
            intendedAction = 'pan';
        } else {
            intendedAction = 'zoom';
        }

        const action = (isNewGesture || !this.lastWheelAction) ? intendedAction : this.lastWheelAction;

        this.lastWheelAction = intendedAction;
        this.lastWheelTime = now;
        this.lastWheelDelta = totalDelta;

        if (action === 'vscroll') {
            this.handleVerticalScroll(e.deltaY);
        } else if (action === 'pan') {
            this.handlePan(e.deltaX);
        } else {
            this.handleZoom(e.deltaY, x);
        }
    }

    private handleZoom(delta: number, centerX: number): void {
        const mouseMs = this.xToMs(centerX);
        const factor = Math.exp(-delta * 0.0015);
        const fullRange = this.maxX - this.minX;
        const minPxPerMs = this.width / fullRange;
        const precision = Number.EPSILON * Math.max(1, Math.abs(this.minX), Math.abs(this.maxX));
        const maxPxPerMs = Math.max(minPxPerMs, 1 / precision);

        this.pxPerMs = Math.max(minPxPerMs, Math.min(
            maxPxPerMs,
            this.pxPerMs * factor
        ));

        const viewWidth = this.width / this.pxPerMs;

        this.offsetMs = Math.max(this.minX, Math.min(
            this.maxX - viewWidth,
            mouseMs - centerX / this.pxPerMs
        ));

        this.#scheduleRender();
    }

    private handlePan(delta: number): void {
        const panAmount = delta / this.pxPerMs;
        const viewWidth = this.width / this.pxPerMs;

        this.offsetMs = Math.max(this.minX, Math.min(
            this.maxX - viewWidth,
            this.offsetMs + panAmount
        ));

        this.#scheduleRender();
    }

    private handleVerticalScroll(delta: number): void {
        this.scrollY += delta;

        const contentHeight = Math.max(0, this.height - LAYOUT.RULER_HEIGHT - LAYOUT.MINIMAP_HEIGHT);
        const maxScroll = Math.max(0, this.contentHeight - contentHeight);

        this.scrollY = Math.max(0, Math.min(maxScroll, this.scrollY));

        this.#scheduleRender();
    }

    private onPointerMove(e: PointerEvent): void {
        const rect = this.overlayCanvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;

        e.stopPropagation();
        this.pointerEvent = e;

        if (this.isDragging) {
            const dx = x - this.lastPointerX;
            const dy = y - this.lastPointerY;

            this.handlePan(-dx * this.width / rect.width);
            this.handleVerticalScroll(-dy);
            this.lastPointerX = x;
            this.lastPointerY = y;

            return;
        }

        this.lastPointerX = x;
        this.lastPointerY = y;

        const span = this.hitTest(x, y);

        if (span !== this.hoveredSpan) {
            this.hoveredSpan = span;
            this.renderOverlay();
            // this.updateTooltip(span, e);

            if (this.options.onHover) {
                this.options.onHover(span, e);
            }
        }
    }

    private onPointerDown(e: PointerEvent): void {
        if (e.button === 0) {
            const rect = this.overlayCanvas.getBoundingClientRect();

            this.dragStartX = e.clientX - rect.left;
            this.dragStartY = e.clientY - rect.top;
            this.isDragging = true;
            this.overlayCanvas.style.cursor = 'grabbing';
            e.stopPropagation();
        }
    }

    private onPointerUp(e: PointerEvent): void {
        if (e.button === 0) {
            const rect = this.overlayCanvas.getBoundingClientRect();
            const x = e.clientX - rect.left;
            const y = e.clientY - rect.top;

            const dx = Math.abs(x - this.dragStartX);
            const dy = Math.abs(y - this.dragStartY);
            const isClick = dx < 5 && dy < 5;

            this.isDragging = false;
            this.overlayCanvas.style.cursor = 'default';

            if (isClick) {
                if (this.handleGroupTitleClick(x, y)) {
                    return;
                }

                const span = this.hitTest(x, y);

                if (this.options.onClick) {
                    this.options.onClick(span, e);
                }
            }
        }
    }

    private onPointerLeave(e: PointerEvent): void {
        this.pointerEvent = null;
        this.isDragging = false;
        this.overlayCanvas.style.cursor = 'default';

        if (this.hoveredSpan) {
            this.hoveredSpan = null;
            this.renderOverlay();
            // this.updateTooltip(null, e);

            if (this.options.onHover) {
                this.options.onHover(null, e);
            }
        }
    }

    private hitTest(x: number, y: number): Span | null {
        const contentY = LAYOUT.RULER_HEIGHT;
        const minimapY = this.height - LAYOUT.MINIMAP_HEIGHT;

        if (y < contentY || y >= minimapY) {
            return null;
        }

        const offset = y - contentY + this.scrollY;
        const trackIdx = this.findTrackAtOffset(offset);

        if (trackIdx === this.tracks.length || offset < this.trackOffsets[trackIdx]) {
            return null;
        }

        const track = this.tracks[trackIdx];
        if (track.isGroupTitle) {
            return null;
        }

        const image = this.trackImages.get(track);

        if (!image || x < 0 || x >= this.width) {
            return null;
        }

        let lower = 0;
        let upper = image.spans.length;

        while (lower < upper) {
            const middle = (lower + upper) >>> 1;

            if (image.positions[middle * 2] <= x) {
                lower = middle + 1;
            } else {
                upper = middle;
            }
        }

        const position = lower - 1;

        if (position < 0) {
            return null;
        }

        const start = image.positions[position * 2];
        const end = image.positions[position * 2 + 1];
        const hitEnd = end - start < 5
            ? Math.min(end + 2, image.positions[lower * 2] ?? this.width)
            : end;

        return x < hitEnd ? image.spans[position] : null;
    }

    private handleGroupTitleClick(x: number, y: number): boolean {
        if (!this.options.groups) {
            return false;
        }

        const contentY = LAYOUT.RULER_HEIGHT;
        const minimapY = this.height - LAYOUT.MINIMAP_HEIGHT;

        if (y < contentY || y >= minimapY) {
            return false;
        }

        for (let i = 0; i < this.tracks.length; i++) {
            const track = this.tracks[i];

            if (!track.isGroupTitle) {
                continue;
            }

            const trackY = this.getTrackY(i);
            const height = LAYOUT.GROUP_TITLE_HEIGHT;

            if (y >= trackY && y < trackY + height) {
                track.group!.collapsed = !track.group!.collapsed;
                this.#layoutGroupIndex = 0;
                this.layoutTracks();
                this.#scheduleLayout();
                this.#scheduleRender();

                return true;
            }
        }

        return false;
    }

    // private updateTooltip(span: Span | null, e: MouseEvent | PointerEvent): void {
    //     if (!span) {
    //         this.tooltip.style.display = 'none';
    //         return;
    //     }

    //     const duration = span.end - span.start;
    //     this.tooltip.innerHTML = `
    //         <strong>${span.text || 'Unnamed'}</strong><br>
    //         Duration: ${this.formatTime(duration, duration / 10, duration * 2)}<br>
    //         Start: ${this.formatTime(span.start, span.start / 10, span.start * 2)}
    //     `;

    //     this.tooltip.style.display = 'block';
    //     this.tooltip.style.left = (e.clientX + 10) + 'px';
    //     this.tooltip.style.top = (e.clientY + 10) + 'px';
    // }
}
