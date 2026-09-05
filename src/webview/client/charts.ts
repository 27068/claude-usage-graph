// SPDX-License-Identifier: AGPL-3.0-only

import {
  Chart,
  Filler,
  Legend,
  LineController,
  LineElement,
  LinearScale,
  PointElement,
  Tooltip,
} from 'chart.js';
import { markersInFrame } from '../../core/markers';
import { localHourTicks, localMidnightTicks, localNoonTicks } from '../../core/ticks';
import { formatClock24 } from '../../core/sessions';
import type { ChartPoint, ChartSeries, Millis } from '../../core/types';

Chart.register(LineController, LineElement, PointElement, LinearScale, Legend, Tooltip, Filler);

export interface VerticalMarker {
  x: Millis;
  color: string;
  label: string;
  dashed?: boolean;
}

/**
 * Canvas pixels reserved above the plot for the marker labels, claimed through
 * `layout.padding.top` in createChart.
 *
 * A label drawn inside the plot would cross any series near the top of the
 * scale — and with only five points of headroom above 100%, "near the top"
 * starts around 92%, exactly when a pegged pool is worth reading. A strip
 * outside the plot cannot cover a value, and costs the chart only this band.
 */
const MARKER_BAND_PX = 16;

/** Minimum clear space between two labels sharing the band. */
const MARKER_LABEL_GAP = 8;

/**
 * Baseline of the label text, measured up from the top of the plot.
 *
 * The line stops at the plot edge and the text sits just above it. Nothing
 * bridges the two because nothing needs to: a centred label is already directly
 * over its line, and the labels carry the line's own colour. Carrying the line
 * up into the band instead only forced the text higher to clear the stub, and
 * the tip then crowded whichever glyph it rose under.
 */
const MARKER_LABEL_BASELINE = 5;

/**
 * The label font, built at draw time.
 *
 * `var()` is **not** valid in the canvas font shorthand — assigning
 * `'11px var(--vscode-font-family, sans-serif)'` is rejected silently, leaving
 * whatever font the context already carried. The variable has to be resolved
 * here and a plain family list handed to the canvas.
 */
function markerLabelFont(): string {
  return `11px ${cssVar('--vscode-font-family', 'sans-serif')}`;
}

interface PlacedLabel {
  text: string;
  color: string;
  left: number;
  width: number;
}

/**
 * A run of labels that have been pushed together and must now be laid out
 * end to end. A lone label is a cluster of one, which is the common case.
 */
interface Cluster {
  members: PlacedLabel[];
  /** Laid-out width of the whole run, internal gaps included. */
  width: number;
  /**
   * Σ (preferred start − offset within the run). Divided by the member count
   * this is the run's least-displacement start: the position where the total
   * distance the members have been dragged from their own lines is smallest.
   */
  demand: number;
  start: number;
}

/** Settle a cluster at its least-displacement start, inside the plot. */
function settle(cluster: Cluster, area: { left: number; right: number }): void {
  const ideal = cluster.demand / cluster.members.length;
  const limit = area.right - cluster.width;
  // A run wider than the plot cannot be contained; anchoring it left keeps the
  // labels legible and in order, and lets the last one clip.
  cluster.start = limit < area.left ? area.left : Math.min(Math.max(ideal, area.left), limit);
}

/**
 * Lay the labels across the band, centred on their lines.
 *
 * Centred is the placement that needs no explaining: the text sits on top of the
 * thing it names. Everything else here exists to keep that true when two lines
 * are close — Now closing on a reset wall, which happens every session and
 * happens precisely when someone is watching.
 *
 * Labels that would touch are gathered into a cluster and laid out end to end,
 * then the whole run is shifted to the position that minimises how far its
 * members sit from their own lines. That splits a collision between the labels
 * involved rather than pinning one and shoving the other, and because a
 * collision is resolved by moving a *run* — merging into the neighbour on the
 * left when the shift pushes it that far — the result cannot overlap no matter
 * how many lines crowd together. The same merge absorbs the plot edges: a label
 * clamped inward becomes a cluster that the ones behind it make room for.
 */
function placeLabels(
  ctx: CanvasRenderingContext2D,
  markers: ReadonlyArray<{ line: VerticalMarker; x: number }>,
  area: { left: number; right: number },
): PlacedLabel[] {
  const clusters: Cluster[] = [];

  // Line order, not label order: a label may end up left of a neighbour whose
  // line is left of its own, and that reads as a mix-up.
  for (const { line, x } of [...markers].sort((a, b) => a.x - b.x)) {
    const width = ctx.measureText(line.label).width;
    const centred = x - width / 2;
    const member: PlacedLabel = { text: line.label, color: line.color, left: centred, width };
    clusters.push({ members: [member], width, demand: centred, start: centred });
    settle(clusters[clusters.length - 1] as Cluster, area);

    // Absorb every neighbour the new cluster now runs into. Each merge can move
    // the combined run further left, so this repeats rather than checking once.
    while (clusters.length > 1) {
      const right = clusters[clusters.length - 1] as Cluster;
      const left = clusters[clusters.length - 2] as Cluster;
      if (left.start + left.width + MARKER_LABEL_GAP <= right.start) {
        break;
      }
      // Everything in the right-hand run shifts by the left run's width, so its
      // contribution to the shared demand shifts with it.
      const offset = left.width + MARKER_LABEL_GAP;
      const merged: Cluster = {
        members: [...left.members, ...right.members],
        width: left.width + MARKER_LABEL_GAP + right.width,
        demand: left.demand + right.demand - right.members.length * offset,
        start: 0,
      };
      settle(merged, area);
      clusters.splice(clusters.length - 2, 2, merged);
    }
  }

  const placed: PlacedLabel[] = [];
  for (const cluster of clusters) {
    let cursor = cluster.start;
    for (const member of cluster.members) {
      member.left = cursor;
      cursor += member.width + MARKER_LABEL_GAP;
      placed.push(member);
    }
  }
  return placed;
}

/**
 * Draws the reset wall and the NOW line.
 *
 * Hand-rolled rather than pulling in chartjs-plugin-annotation: it is thirty
 * lines, it removes a vendored dependency from an AGPL project, and it gives
 * direct control over label placement against the plot edge.
 */
const verticalMarkers = {
  id: 'verticalMarkers',
  afterDatasetsDraw(chart: Chart): void {
    const markers = (chart.options.plugins as Record<string, unknown> | undefined)?.[
      'verticalMarkers'
    ] as { lines?: VerticalMarker[] } | undefined;
    const lines = markers?.lines ?? [];
    if (lines.length === 0) {
      return;
    }

    const { ctx, chartArea, scales } = chart;
    const scale = scales.x;

    // The range comes from the scale rather than the view because Chart.js is
    // the last word on it; we set min/max explicitly in createChart, so the two
    // agree, and `core/markers.ts` is where the rule itself is tested.
    const visible = markersInFrame(lines, [scale.min, scale.max]).map((line) => ({
      line,
      x: scale.getPixelForValue(line.x),
    }));

    ctx.save();
    for (const { line, x } of visible) {
      ctx.beginPath();
      ctx.setLineDash(line.dashed === true ? [3, 3] : []);
      ctx.lineWidth = 2;
      ctx.strokeStyle = line.color;
      ctx.moveTo(x, chartArea.top);
      ctx.lineTo(x, chartArea.bottom);
      ctx.stroke();
    }

    ctx.setLineDash([]);
    ctx.font = markerLabelFont();
    ctx.textAlign = 'left';
    // Every part of the text state has to be stated, because none of it is
    // ours: the context arrives however Chart.js last left it, and that differs
    // between the two graphs. Graph 2 draws a legend before the datasets, which
    // leaves `middle` behind — enough to drop the labels onto the plot edge
    // there while graph 1, with no legend, sat correctly at `alphabetic`.
    ctx.textBaseline = 'alphabetic';
    const baseline = chartArea.top - MARKER_LABEL_BASELINE;
    for (const label of placeLabels(ctx, visible, chartArea)) {
      ctx.fillStyle = label.color;
      ctx.fillText(label.text, label.left, baseline);
    }
    ctx.restore();
  },
};

Chart.register(verticalMarkers);

function cssVar(name: string, fallback: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value.length > 0 ? value : fallback;
}

export function seriesColors(): string[] {
  return [
    cssVar('--vscode-charts-blue', '#3794ff'),
    cssVar('--vscode-charts-green', '#89d185'),
    cssVar('--vscode-charts-purple', '#b180d7'),
    cssVar('--vscode-charts-orange', '#d18616'),
  ];
}

function formatWeekday(at: Millis): string {
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date(at).getDay()];
}

/**
 * Graph 2's x axis carries two kinds of tick. Midnights draw a gridline and no
 * text — the day boundary is a line, and a weekday sitting on it names neither
 * side. Noons draw text and no line, so each label floats in the middle of the
 * day it names. Which kind a tick is can be read straight off the clock,
 * because both sets come from core/ticks.ts and nothing else lands on 12:00.
 */
function isWeekdayLabelTick(at: Millis): boolean {
  return new Date(at).getHours() === 12;
}

export function createChart(
  canvas: HTMLCanvasElement,
  kind: 'pool' | 'calendar',
): Chart<'line', Array<{ x: number; y: number | null }>> {
  const grid = cssVar('--vscode-panel-border', 'rgba(128,128,128,0.35)');
  const text = cssVar('--vscode-foreground', '#cccccc');

  return new Chart(canvas, {
    type: 'line',
    data: { datasets: [] },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      parsing: false,
      normalized: true,
      interaction: { mode: 'nearest', axis: 'x', intersect: false },
      // The strip the marker labels are drawn in. Chart.js fits every box —
      // legend and axes — inside this padding, so with the legend moved to the
      // bottom (below) nothing else claims the top and `chartArea.top` lands
      // exactly MARKER_BAND_PX down the canvas.
      layout: { padding: { top: MARKER_BAND_PX } },
      scales: {
        x: {
          type: 'linear',
          grid: {
            // Scriptable so the label-only noon ticks stay invisible as lines;
            // tickColor is the stub outside the axis and would otherwise show.
            color: (ctx: { tick?: { value: number } }) =>
              kind === 'calendar' && ctx.tick !== undefined && isWeekdayLabelTick(ctx.tick.value)
                ? 'transparent'
                : grid,
            tickColor: (ctx: { tick?: { value: number } }) =>
              kind === 'calendar' && ctx.tick !== undefined && isWeekdayLabelTick(ctx.tick.value)
                ? 'transparent'
                : grid,
          },
          ticks: {
            color: text,
            maxRotation: 0,
            autoSkip: false,
            callback: (value) => {
              const at = Number(value);
              if (kind !== 'calendar') return formatClock24(at);
              return isWeekdayLabelTick(at) ? formatWeekday(at) : '';
            },
          },
          // Without this the linear scale invents its own round numbers and
          // draws gridlines at times like 22:16. See core/ticks.ts.
          afterBuildTicks: (scale: { min: number; max: number; ticks: Array<{ value: number }> }) => {
            const positions =
              kind === 'calendar'
                ? [
                    ...localMidnightTicks(scale.min, scale.max),
                    ...localNoonTicks(scale.min, scale.max),
                  ].sort((a, b) => a - b)
                : localHourTicks(scale.min, scale.max);
            scale.ticks = positions.map((value) => ({ value }));
          },
        },
        y: {
          min: 0,
          // A little headroom above 100 so a pegged series does not draw its
          // line flush against the top edge of the plot area.
          max: 105,
          grid: { color: grid },
          ticks: { color: text, stepSize: 10, callback: (value) => `${value}%` },
          // The headroom is padding, not a value anyone should read. Chart.js
          // has already fixed the scale range from the generated ticks by the
          // time this runs, so dropping everything at or above 100 and adding
          // 100 back keeps the axis topped by a 100% gridline without letting
          // the padding show up as a label.
          afterBuildTicks: (scale: { ticks: Array<{ value: number }> }) => {
            scale.ticks = scale.ticks.filter((tick) => tick.value < 100);
            scale.ticks.push({ value: 100 });
          },
          title: { display: true, text: 'Usage', color: text },
        },
      },
      plugins: {
        legend: {
          display: kind === 'calendar',
          // Below the plot, because the top of the canvas is the marker-label
          // band. The series are already named by the HTML toggles above the
          // chart; what the legend adds is the colour each name is drawn in,
          // and that reads the same from either side.
          position: 'bottom',
          labels: { color: text, usePointStyle: true, boxHeight: 6 },
        },
        tooltip: {
          callbacks: {
            title: (items) => {
              const at = Number(items[0]?.parsed.x ?? 0);
              return kind === 'calendar'
                ? `${formatWeekday(at)} ${formatClock24(at)}`
                : formatClock24(at);
            },
            label: (item) => `${item.dataset.label}: ${item.parsed.y}%`,
          },
        },
      },
    },
  }) as Chart<'line', Array<{ x: number; y: number | null }>>;
}

/**
 * Line weight and dot size are single constants, not per-series values: the
 * five-hour and weekly graphs are meant to read as one instrument. DOT_RADIUS is
 * the true drawn radius only because the datasets below also zero the point
 * border; see the note there.
 */
const LINE_WIDTH = 2;
const DOT_RADIUS = (LINE_WIDTH + 1) / 2;

/**
 * The scriptable-option context Chart.js hands the per-point callbacks.
 *
 * `data` is `unknown[]` on purpose. Chart.js declares it as
 * `(number | Point | null)[]`, and a narrower parameter type here fails to
 * typecheck against the scriptable-option signature; `unknown[]` accepts it and
 * the guard below does the narrowing.
 */
interface PointContext {
  dataIndex: number;
  dataset: { data: unknown[] };
}

/**
 * How close two samples may sit on the canvas before the second one stops
 * carrying information a reader can act on.
 *
 * The distance is measured in *two* dimensions, which is the whole point. A
 * purely horizontal rule would have to be coarse enough to swallow a nine-minute
 * flat run, and would then also swallow a four-minute jump from 2% to 4% — a
 * real step, deleted for being brief. Because a percentage change is a long way
 * up the y axis even when it is a short way along x, `hypot` keeps every value
 * transition and drops only the samples that repeat what is already on screen.
 */
const MIN_POINT_DISTANCE_PX = 2;

/** Canvas pixels per millisecond and per utilization point, for the live view. */
interface Geometry {
  pxPerMs: number;
  pxPerUnit: number;
}

function geometryOf(chart: Chart<'line', Array<{ x: number; y: number | null }>>): Geometry | undefined {
  const x = chart.options.scales?.['x'] as { min?: number; max?: number } | undefined;
  const y = chart.options.scales?.['y'] as { min?: number; max?: number } | undefined;
  const span = (x?.max ?? 0) - (x?.min ?? 0);
  const range = (y?.max ?? 0) - (y?.min ?? 0);
  if (span <= 0 || range <= 0) {
    return undefined;
  }
  // chartArea is only populated once the chart has laid out at least once, so on
  // the very first paint fall back to the canvas box. It overstates the plot by
  // the width of the axis furniture, which errs toward keeping samples — the
  // safe direction.
  const area = chart.chartArea as { width?: number; height?: number } | undefined;
  const width = area?.width ?? chart.canvas.clientWidth;
  const height = area?.height ?? chart.canvas.clientHeight;
  if (!(width > 0) || !(height > 0)) {
    return undefined;
  }
  return { pxPerMs: width / span, pxPerUnit: height / range };
}

/**
 * Drop samples that would land on top of the one before them.
 *
 * Thinning happens here rather than in the ledger because it is a fact about the
 * viewport, not about the data: the same run is four pixels wide in a narrow
 * panel and forty in a wide one. `core/sampleRules.ts` has already compressed
 * each flat run to an anchor and a bookend, so nothing dropped here is
 * redundant on disk — it is redundant *on this screen, at this width*.
 *
 * Two properties make this safe to do to real measurements:
 *
 *  - No value is averaged or synthesised. Every point that survives is exactly
 *    as recorded; the rest are simply not drawn.
 *  - Nothing on screen moves by more than MIN_POINT_DISTANCE_PX. Because
 *    `stepped: 'after'` holds a value until the next x, dropping a sample defers
 *    its step to the next surviving sample — and that one is by construction
 *    within two pixels.
 *
 * Nulls are never dropped: they are the dead-zone breaks, and they end the run
 * so the next sample always survives.
 */
function thinForDisplay(points: readonly ChartPoint[], geometry: Geometry): ChartPoint[] {
  const kept: ChartPoint[] = [];
  let anchor: ChartPoint | undefined;

  for (const point of points) {
    if (point.y === null) {
      kept.push(point);
      anchor = undefined;
      continue;
    }
    if (anchor === undefined || anchor.y === null) {
      kept.push(point);
      anchor = point;
      continue;
    }
    const dx = (point.x - anchor.x) * geometry.pxPerMs;
    const dy = (point.y - anchor.y) * geometry.pxPerUnit;
    if (Math.hypot(dx, dy) >= MIN_POINT_DISTANCE_PX) {
      kept.push(point);
      anchor = point;
    }
  }

  return kept;
}

/**
 * Is this sample drawn by nothing but itself?
 *
 * A sample with a live neighbour is already described by the line segment
 * leaving it, so a dot there is redundant ink. A sample with a gap — or the end
 * of the series — on *both* sides has no segment at all and would render as
 * nothing whatsoever: a brand-new ledger holding one reading, or a lone reading
 * marooned between two dead zones. Those are the only points worth a dot.
 *
 * `stepped: 'after'` with `spanGaps: false` is what makes this exact: a segment
 * exists between two indices precisely when both hold a non-null `y`.
 */
function isIsolated(data: unknown[], index: number): boolean {
  const plotted = (at: number): boolean => {
    const point = data[at] as ChartPoint | null | undefined;
    return point != null && point.y != null;
  };
  return plotted(index) && !plotted(index - 1) && !plotted(index + 1);
}

export function applySeries(
  chart: Chart<'line', Array<{ x: number; y: number | null }>>,
  series: ChartSeries[],
  visible: string[] | undefined,
): void {
  const colors = seriesColors();
  // Undefined before the first layout, or if the domain has not been set yet —
  // in which case everything is drawn and the next render thins it.
  const geometry = geometryOf(chart);

  chart.data.datasets = series
    // Colour is keyed to the series' fixed position, not to its position after
    // filtering — otherwise hiding one series recolours the ones left behind.
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => visible === undefined || visible.includes(entry.key))
    .map(({ entry, index }) => ({
      label: entry.label,
      data: geometry === undefined ? entry.points : thinForDisplay(entry.points, geometry),
      // The whole visual grammar: hold flat, then jump vertically.
      stepped: 'after' as const,
      borderColor: colors[index % colors.length],
      backgroundColor: colors[index % colors.length],
      // One weight for every line in both graphs. Colour alone separates the
      // series; a thinner stroke for the later ones only made the weekly chart
      // look like a different instrument than the five-hour one.
      borderWidth: LINE_WIDTH,
      // Only isolated samples get a dot; everything else is already drawn by the
      // line. See isIsolated.
      pointRadius: (context: PointContext) =>
        isIsolated(context.dataset.data, context.dataIndex) ? DOT_RADIUS : 0,
      // Chart.js fills a point to its radius and *then* strokes a border around
      // it, so the default 1px border silently makes every dot a pixel wider
      // than DOT_RADIUS describes. Zero it out and the radius means what it says.
      pointBorderWidth: 0,
      // The hover sizes need the same treatment, and matter more than they look:
      // interaction is `nearest` with `intersect: false`, so a point is active
      // whenever the cursor is anywhere over the plot — not only when it is on
      // top of one. Left at the Chart.js defaults (radius 4, border 1) every
      // point the mouse passed near would swell to 9px. Kept small, this is what
      // shows which sample the tooltip is reading, since most points now draw no
      // dot of their own.
      pointHoverRadius: DOT_RADIUS + 1,
      pointHoverBorderWidth: 0,
      pointHitRadius: 8,
      // Chart.js would otherwise bridge a null and hide the dead zone.
      spanGaps: false,
      tension: 0,
    }));
}

/**
 * A reset wall. Both graphs use the same red line so the boundary reads as one
 * concept: the five-hour pool clearing and the weekly allowance rolling over are
 * the same kind of event at different scales. The label comes from the caller —
 * the selectors build every one of them.
 */
export function resetMarker(at: Millis, label: string): VerticalMarker {
  return { x: at, color: cssVar('--vscode-charts-red', '#f14c4c'), label };
}

export function nowMarker(at: Millis): VerticalMarker {
  return {
    x: at,
    color: cssVar('--vscode-descriptionForeground', '#9d9d9d'),
    label: 'Now',
    dashed: true,
  };
}
