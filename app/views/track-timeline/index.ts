import type { Span, SpanGroup, Track, TrackTimelineOptions, VisibleTrackRange, Interval } from './types.js';

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
    private groups: SpanGroup[] = [];
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
    private selectedSpan: Span | null = null;
    private isDragging = false;
    private dragStartX = 0;
    private dragStartY = 0;
    private lastPointerX = 0;
    private lastPointerY = 0;
    #renderScheduled: number | null = null;
    #shouldResize = true;

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
        if (useGroups !== undefined) {
            this.options.groups = useGroups;
        }

        if (this.options.groups) {
            this.groups = (spans as SpanGroup[]).map(group => ({
                name: group.name || 'Unnamed Group',
                collapsed: group.collapsed || false,
                spans: group.spans,
                intervals: this.sortIntervals(group.intervals || [])
            }));
            this.options.spans = [];
        } else {
            this.options.spans = spans as Span[];
            this.groups = [];
        }

        this.computeBounds();
        this.layoutTracks();
        this.#scheduleRender();
    }

    public setIntervals(intervals: Interval[]): void {
        this.intervals = this.sortIntervals(intervals || []);
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
        this.resizeObserver.disconnect();
        if (this.#renderScheduled) {
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
        this.overlayCanvas.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
        this.overlayCanvas.addEventListener('pointermove', (e) => this.onPointerMove(e));
        this.overlayCanvas.addEventListener('pointerdown', (e) => this.onPointerDown(e));
        this.overlayCanvas.addEventListener('pointerup', (e) => this.onPointerUp(e));
        this.overlayCanvas.addEventListener('pointerleave', (e) => this.onPointerLeave(e));
    }

    private resize(): void {
        const prevWidth = this.width;
        const rect = this.container.getBoundingClientRect();
        this.width = rect.width;
        this.height = rect.height;

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
    }

    private computeBounds(): void {
        let minX = Number.isFinite(this.options.minX) ? this.options.minX : Infinity;
        let maxX = Number.isFinite(this.options.maxX) ? this.options.maxX : -Infinity;

        if (!isFinite(minX) || !isFinite(maxX)) {
            const allSpans = this.options.groups
                ? this.groups.flatMap(group => group.spans)
                : this.options.spans;

            if (allSpans.length > 0) {
                if (!isFinite(minX)) {
                    minX = Math.min(...allSpans.map(s => s.start));
                }
                if (!isFinite(maxX)) {
                    maxX = Math.max(...allSpans.map(s => s.end));
                }
            }
        }

        this.setBounds(minX, maxX);
    }

    private layoutTracks(): void {
        if (this.options.groups) {
            this.tracks = [];
            for (const group of this.groups) {
                this.tracks.push({ isGroupTitle: true, group, spans: [] });
                if (!group.collapsed) {
                    const groupTracks = this.layoutGroupTracks(group.spans);
                    this.tracks.push(...groupTracks.map(spans => ({
                        isGroupTitle: false,
                        group,
                        spans
                    })));
                }
            }
        } else {
            const groupTracks = this.layoutGroupTracks(this.options.spans as Span[]);
            this.tracks = groupTracks.map(spans => ({
                isGroupTitle: false,
                group: null,
                spans
            }));
        }
    }

    private layoutGroupTracks(spans: Span[]): Span[][] {
        const sorted = [...spans].sort((a, b) => (b.end - b.start) - (a.end - a.start));
        const tracks: Span[][] = [];

        for (const span of sorted) {
            const trackIdx = tracks.findIndex(track => !this.hasConflict(track, span));
            if (trackIdx !== -1) {
                tracks[trackIdx].push(span);
            } else {
                tracks.push([span]);
            }
        }

        // Sort each track by start time
        tracks.forEach(track => track.sort((a, b) => a.start - b.start));

        return tracks;
    }

    private hasConflict(track: Span[], span: Span): boolean {
        const minDuration = 0.001;
        const spanEnd = Math.max(span.end, span.start + minDuration);

        return track.some(existing => {
            const existingEnd = Math.max(existing.end, existing.start + minDuration);
            return existing.start < spanEnd && span.start < existingEnd;
        });
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
        const contentHeight = this.height - LAYOUT.RULER_HEIGHT - LAYOUT.MINIMAP_HEIGHT;
        const visibleStart = this.scrollY;
        const visibleEnd = this.scrollY + contentHeight;

        let start = 0;
        let end = this.tracks.length;

        for (let i = 0; i < this.tracks.length; i++) {
            const trackStart = this.getTrackStartY(i);
            const trackEnd = trackStart + this.getTrackHeight(i);

            if (trackEnd > visibleStart && trackStart < visibleEnd) {
                if (i < start) {
                    start = i;
                }
                if (i + 1 > end) {
                    end = i + 1;
                }
            }

            if (trackStart >= visibleEnd) {
                break;
            }
        }

        return { start, end };
    }

    private getTrackHeight(trackIdx: number): number {
        const track = this.tracks[trackIdx];
        return track?.isGroupTitle ? LAYOUT.GROUP_TITLE_HEIGHT : LAYOUT.TRACK_HEIGHT;
    }

    private getTrackStartY(trackIdx: number): number {
        let y = 0;
        for (let i = 0; i < trackIdx; i++) {
            y += this.getTrackHeight(i) + LAYOUT.TRACK_GAP;
        }
        return y;
    }

    private getTrackY(trackIdx: number): number {
        return LAYOUT.RULER_HEIGHT + this.getTrackStartY(trackIdx) - this.scrollY;
    }

    #scheduleRender() {
        if (!this.#renderScheduled) {
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
        this.renderOverlay();
    }

    private renderBase(): void {
        const ctx = this.baseCtx;

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

        for (let i = trackRange.start; i < trackRange.end; i++) {
            const track = this.tracks[i];
            const trackY = this.getTrackY(i);

            if (track.isGroupTitle) {
                this.renderGroupTitleBackground(ctx, trackY);

                // Render group intervals after group title
                if (track.group?.intervals) {
                    const groupStartY = trackY;
                    let groupEndY = trackY + LAYOUT.GROUP_TITLE_HEIGHT;

                    // Find the end of this group
                    if (!track.group.collapsed) {
                        for (let j = i + 1; j < this.tracks.length; j++) {
                            const nextTrack = this.tracks[j];
                            if (nextTrack.isGroupTitle || nextTrack.group !== track.group) {
                                break;
                            }
                            groupEndY = this.getTrackY(j) + LAYOUT.TRACK_HEIGHT;
                        }
                    }

                    this.renderIntervals(ctx, track.group.intervals, groupStartY, groupEndY);
                }

                this.renderGroupTitleForeground(ctx, trackY, track);
            } else {
                this.renderTrack(ctx, track.spans, trackY);
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
        const startTick = this.options.ruler === 'absolute'
            ? Math.ceil(viewStart / tickInterval) * tickInterval
            : tickBase;

        ctx.fillStyle = COLORS.TEXT_SECONDARY;
        ctx.font = '11px system-ui';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';

        for (let tick = startTick; tick <= viewEnd; tick += tickInterval) {
            const x = this.msToX(tick);

            ctx.strokeStyle = COLORS.BORDER;
            ctx.beginPath();
            ctx.moveTo(x, rulerHeight - 8);
            ctx.lineTo(x, rulerHeight);
            ctx.stroke();

            const label = this.formatTime(tick - tickBase, tickInterval, range);
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

    private renderGroupTitleForeground(ctx: CanvasRenderingContext2D, trackY: number, trackData: Track): void {
        const group = trackData.group!;
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

    private renderTrack(ctx: CanvasRenderingContext2D, track: Span[], trackY: number): void {
        const viewStart = this.offsetMs;
        const viewEnd = this.offsetMs + this.width / this.pxPerMs;

        for (const span of track) {
            if (span.end <= viewStart) {
                continue;
            }
            if (span.start >= viewEnd) {
                break;
            }
            this.renderSpan(ctx, span, trackY);
        }
    }

    private renderSpan(ctx: CanvasRenderingContext2D, span: Span, trackY: number): void {
        const x1 = this.msToX(span.start);
        const x2 = this.msToX(span.end);
        const width = Math.max(1, x2 - x1);
        const height = LAYOUT.TRACK_HEIGHT;

        ctx.fillStyle = span.color || this.getDefaultColor(span);
        ctx.fillRect(x1, trackY, width, height);

        if (width > 20 && span.text) {
            const maxWidth = width - (LAYOUT.TRACK_PADDING + 2) * 2;

            ctx.save();
            ctx.fillStyle = '#fff';
            ctx.font = '10px system-ui';
            ctx.textAlign = 'left';
            ctx.textBaseline = 'middle';

            let displayText = span.text;
            if (ctx.measureText(span.text).width > maxWidth) {
                let low = 0;
                let high = span.text.length;
                while (low < high) {
                    const mid = Math.floor((low + high + 1) / 2);
                    const testText = span.text.substring(0, mid) + '…';
                    if (ctx.measureText(testText).width <= maxWidth) {
                        low = mid;
                    } else {
                        high = mid - 1;
                    }
                }
                displayText = span.text.substring(0, low) + '…';
            }

            ctx.beginPath();
            ctx.rect(x1 + LAYOUT.TRACK_PADDING, trackY, width - LAYOUT.TRACK_PADDING * 2, height);
            ctx.clip();
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

        if (this.selectedSpan) {
            const x1 = msToMinimapX(this.selectedSpan.start);
            const x2 = msToMinimapX(this.selectedSpan.end);
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

        if (this.selectedSpan) {
            const trackIdx = this.findTrackForSpan(this.selectedSpan);
            if (trackIdx !== -1) {
                const trackY = this.getTrackY(trackIdx);
                this.renderSpanHighlight(ctx, this.selectedSpan, trackY, COLORS.SELECTED_FILL, COLORS.SELECTED_BORDER);
            }
        }

        ctx.restore();
    }

    private renderSpanHighlight(ctx: CanvasRenderingContext2D, span: Span, trackY: number, color: string, borderColor: string): void {
        const x1 = this.msToX(span.start);
        const x2 = this.msToX(span.end);
        const width = Math.max(1, x2 - x1);
        const height = LAYOUT.TRACK_HEIGHT;

        ctx.fillStyle = color;
        ctx.fillRect(x1, trackY, width, height);

        ctx.strokeStyle = borderColor;
        ctx.lineWidth = 1;
        ctx.strokeRect(x1 + 1, trackY + 1, width - 2, height - 2);
    }

    private findTrackForSpan(span: Span): number {
        return this.tracks.findIndex(track => !track.isGroupTitle && track.spans.includes(span));
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

        this.pxPerMs *= factor;

        const fullRange = this.maxX - this.minX;
        const minPxPerMs = this.width / fullRange;
        const maxPxPerMs = minPxPerMs * 1000;
        this.pxPerMs = Math.max(minPxPerMs, Math.min(maxPxPerMs, this.pxPerMs));

        const viewWidth = this.width / this.pxPerMs;
        this.offsetMs = Math.max(this.minX, Math.min(this.maxX - viewWidth, mouseMs - centerX / this.pxPerMs));

        this.#scheduleRender();
    }

    private handlePan(delta: number): void {
        const panAmount = delta / this.pxPerMs;
        this.offsetMs += panAmount;

        const viewWidth = this.width / this.pxPerMs;
        this.offsetMs = Math.max(this.minX, Math.min(this.maxX - viewWidth, this.offsetMs));

        this.#scheduleRender();
    }

    private handleVerticalScroll(delta: number): void {
        this.scrollY += delta;

        const contentHeight = this.height - LAYOUT.RULER_HEIGHT - LAYOUT.MINIMAP_HEIGHT;
        const totalHeight = this.tracks.reduce((sum, _, i) =>
            sum + this.getTrackHeight(i) + LAYOUT.TRACK_GAP, 0);
        const maxScroll = Math.max(0, totalHeight - contentHeight);

        this.scrollY = Math.max(0, Math.min(maxScroll, this.scrollY));

        this.#scheduleRender();
    }

    private onPointerMove(e: PointerEvent): void {
        const rect = this.overlayCanvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;

        e.stopPropagation();

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
                this.selectedSpan = span;
                this.#scheduleRender();

                if (this.options.onClick) {
                    this.options.onClick(span, e);
                }
            }
        }
    }

    private onPointerLeave(e: PointerEvent): void {
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

        const trackIdx = this.tracks.findIndex((_, i) => {
            const trackY = this.getTrackY(i);
            const trackHeight = this.getTrackHeight(i);
            return y >= trackY && y < trackY + trackHeight;
        });

        if (trackIdx === -1) {
            return null;
        }

        const track = this.tracks[trackIdx];
        if (track.isGroupTitle) {
            return null;
        }

        const ms = this.xToMs(x);
        const spans = track.spans;

        if (spans.length === 0) {
            return null;
        }

        const minHitWidth = 1 / this.pxPerMs;
        const extraHitPadding = 2 / this.pxPerMs;

        let bestMatch: Span | null = null;
        let bestDistance = Infinity;

        for (let i = 0; i < spans.length; i++) {
            const span = spans[i];
            const spanWidth = Math.max(span.end - span.start, minHitWidth);

            let hitStart = span.start;
            let hitEnd = Math.max(span.end, span.start + minHitWidth);

            if (spanWidth < minHitWidth * 5) {
                const prevSpan = i > 0 ? spans[i - 1] : null;
                const maxLeftExpand = prevSpan
                    ? span.start - Math.max(prevSpan.end, prevSpan.start + minHitWidth)
                    : Infinity;
                const leftExpand = Math.min(extraHitPadding, maxLeftExpand, span.start - hitStart);
                hitStart = Math.max(0, hitStart - leftExpand);

                const nextSpan = i < spans.length - 1 ? spans[i + 1] : null;
                const maxRightExpand = nextSpan ? nextSpan.start - hitEnd : Infinity;
                const rightExpand = Math.min(extraHitPadding, maxRightExpand);
                hitEnd += rightExpand;
            }

            if (ms >= hitStart && ms < hitEnd) {
                const spanCenter = (span.start + Math.max(span.end, span.start + minHitWidth)) / 2;
                const distance = Math.abs(ms - spanCenter);

                if (distance < bestDistance) {
                    bestDistance = distance;
                    bestMatch = span;
                }
            }
        }

        return bestMatch;
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
                this.layoutTracks();
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
