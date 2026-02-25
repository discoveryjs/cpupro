export type TimeUnit = 's' | 'ms' | 'us' | 'ns';

export interface Span {
    start: number;
    end: number;
    text?: string;
    color?: string;
}

export interface IntervalSpan {
    start: number;
    end: number;
    color?: string;
    border?: string;
    name?: string;
    zIndex?: number;
}

export interface IntervalLine {
    offset: number;
    color?: string;
    name?: string;
    zIndex?: number;
}

export type Interval = IntervalSpan | IntervalLine;

export interface SpanGroup {
    name: string;
    collapsed?: boolean;
    spans: Span[];
    intervals?: Interval[];
}

export interface TrackTimelineOptions {
    ruler?: 'relative' | 'absolute';
    spans?: Span[] | SpanGroup[];
    unit?: TimeUnit;
    minX?: number;
    maxX?: number;
    onHover?: (span: Span | null, event: MouseEvent) => void;
    onClick?: (span: Span | null, event: MouseEvent) => void;
    groups?: boolean;
    intervals?: Interval[];
}

export interface Track {
    isGroupTitle: boolean;
    group: SpanGroup | null;
    spans: Span[];
}

export interface VisibleTrackRange {
    start: number;
    end: number;
}
