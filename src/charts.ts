/**
 * sportsclaw — Chart Rendering Utilities
 *
 * Converts arrays of numbers into terminal-friendly visualizations.
 * Uses `asciichart` for line charts and provides built-in renderers
 * for sparklines, horizontal bars, vertical columns, and braille plots.
 */

import asciichart from "asciichart";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ChartType = "ascii" | "spark" | "bars" | "columns" | "braille" | "svg";

export interface ChartOptions {
  /** Array of numeric values (single series) or array of arrays (multi-series). */
  data: number[] | number[][];
  /** Chart type to render. */
  chartType: ChartType;
  /** Label for the X axis. */
  xAxisLabel?: string;
  /** Label for the Y axis. */
  yAxisLabel?: string;
  /** Optional labels for each data point on the X axis. */
  xLabels?: string[];
  /** Height in terminal rows (for ascii/braille). Default: 12 */
  height?: number;
}

// ---------------------------------------------------------------------------
// ANSI Colors
// ---------------------------------------------------------------------------

const ANSI = {
  reset: "\x1b[0m",
  cyan: "\x1b[36m",
  magenta: "\x1b[35m",
  yellow: "\x1b[33m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  blue: "\x1b[34m",
  white: "\x1b[37m",
  dim: "\x1b[2m",
};

const SERIES_COLORS = [ANSI.cyan, ANSI.magenta, ANSI.yellow, ANSI.green, ANSI.red, ANSI.blue];
const SERIES_BLOCKS = ["█", "▓", "▒", "░"];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Flatten to a single numeric array (first series if multi). */
function flatSeries(data: number[] | number[][]): number[] {
  if (data.length === 0) return [];
  return Array.isArray(data[0]) ? (data[0] as number[]) : (data as number[]);
}

/** Get all series as number[][]. */
function allSeries(data: number[] | number[][]): number[][] {
  if (data.length === 0) return [];
  return Array.isArray(data[0]) ? (data as number[][]) : [data as number[]];
}

/** Normalize a value to [0, 1] given min/max. */
function normalize(v: number, min: number, max: number): number {
  return max === min ? 0.5 : (v - min) / (max - min);
}

// ---------------------------------------------------------------------------
// Renderers
// ---------------------------------------------------------------------------

/** Line chart using asciichart (box-drawing characters). */
function renderAscii(opts: ChartOptions): string {
  const series = allSeries(opts.data);
  if (series.length === 0 || series[0].length === 0) return "(no data)";

  const height = opts.height ?? 12;
  const colors = [
    asciichart.default,
    asciichart.blue,
    asciichart.green,
    asciichart.red,
    asciichart.yellow,
    asciichart.cyan,
    asciichart.magenta,
  ];

  const cfg: asciichart.PlotConfig = {
    height,
    colors: series.map((_, i) => colors[i % colors.length]),
  };

  const chart = asciichart.plot(
    series.length === 1 ? series[0] : series,
    cfg
  );

  const lines: string[] = [];
  if (opts.yAxisLabel) lines.push(`  ${opts.yAxisLabel}`);
  lines.push(chart);
  if (opts.xAxisLabel) lines.push(`  ${opts.xAxisLabel}`);
  return lines.join("\n");
}

/** Sparkline — compact single-row visualization using block elements. */
function renderSpark(opts: ChartOptions): string {
  const TICKS = "▁▂▃▄▅▆▇█";
  const values = flatSeries(opts.data);
  if (values.length === 0) return "(no data)";

  const min = values.reduce((a, b) => Math.min(a, b), Infinity);
  const max = values.reduce((a, b) => Math.max(a, b), -Infinity);

  const spark = values
    .map((v) => {
      const n = normalize(v, min, max);
      const idx = Math.round(n * (TICKS.length - 1));
      return TICKS[idx];
    })
    .join("");

  const parts: string[] = [];
  if (opts.yAxisLabel) parts.push(`${ANSI.dim}${opts.yAxisLabel}:${ANSI.reset} `);
  parts.push(`${ANSI.cyan}${spark}${ANSI.reset}`);
  parts.push(`  ${ANSI.dim}(${min}–${max})${ANSI.reset}`);
  if (opts.xAxisLabel) parts.push(`\n  ${ANSI.dim}${opts.xAxisLabel}${ANSI.reset}`);
  return parts.join("");
}

/** Horizontal bar chart with ANSI colors and multi-series support. */
function renderBars(opts: ChartOptions): string {
  const series = allSeries(opts.data);
  if (series.length === 0 || series[0].length === 0) return "(no data)";

  const numPoints = series[0].length;
  const labels = opts.xLabels ?? Array.from({ length: numPoints }, (_, i) => String(i + 1));
  const maxLabelLen = labels.map((l) => l.length).reduce((a, b) => Math.max(a, b), 0);
  const globalMax = series.flat().reduce((a, b) => Math.max(a, b), -Infinity);
  const BAR_WIDTH = 40;
  const multiSeries = series.length > 1;

  const lines: string[] = [];

  for (let i = 0; i < numPoints; i++) {
    const label = (labels[i] ?? String(i + 1)).padStart(maxLabelLen);
    for (let s = 0; s < series.length; s++) {
      const v = series[s][i] ?? 0;
      const barLen = globalMax === 0 ? 0 : Math.round((v / globalMax) * BAR_WIDTH);
      const color = SERIES_COLORS[s % SERIES_COLORS.length];
      const fill = SERIES_BLOCKS[s % SERIES_BLOCKS.length];
      const bar = fill.repeat(barLen);
      const prefix = s === 0 ? `${label} │ ` : `${"".padStart(maxLabelLen)} │ `;
      lines.push(`${prefix}${color}${bar}${ANSI.reset} ${ANSI.dim}${v}${ANSI.reset}`);
    }
    if (multiSeries && i < numPoints - 1) {
      lines.push(`${"".padStart(maxLabelLen)} │`);
    }
  }

  // Legend for multi-series
  if (multiSeries) {
    lines.push("");
    const legend = series
      .map((_, s) => {
        const color = SERIES_COLORS[s % SERIES_COLORS.length];
        const fill = SERIES_BLOCKS[s % SERIES_BLOCKS.length];
        return `${color}${fill}${fill}${ANSI.reset} Series ${s + 1}`;
      })
      .join("  ");
    lines.push(`  ${legend}`);
  }

  const parts: string[] = [];
  if (opts.yAxisLabel) parts.push(`  ${ANSI.dim}${opts.yAxisLabel}${ANSI.reset}`);
  parts.push(...lines);
  if (opts.xAxisLabel) parts.push(`  ${ANSI.dim}${opts.xAxisLabel}${ANSI.reset}`);
  return parts.join("\n");
}

/** Vertical column chart with ANSI colors and multi-series support. */
function renderColumns(opts: ChartOptions): string {
  const BLOCKS = "▁▂▃▄▅▆▇█";
  const series = allSeries(opts.data);
  if (series.length === 0 || series[0].length === 0) return "(no data)";

  const numPoints = series[0].length;
  const labels = opts.xLabels ?? Array.from({ length: numPoints }, (_, i) => String(i + 1));
  const globalMax = series.flat().reduce((a, b) => Math.max(a, b), -Infinity);
  const height = opts.height ?? 8;
  const multiSeries = series.length > 1;
  // Each data point gets one column per series, separated by a gap between points
  const colsPerPoint = series.length;
  const totalCols = numPoints * colsPerPoint + (numPoints - 1); // gaps between points

  const rows: string[] = [];

  // Build column grid top-down
  for (let row = height; row >= 1; row--) {
    const threshold = (row / height) * globalMax;
    const prevThreshold = ((row - 1) / height) * globalMax;
    let line = "  ";
    for (let p = 0; p < numPoints; p++) {
      if (p > 0) line += " "; // gap between points
      for (let s = 0; s < series.length; s++) {
        const v = series[s][p] ?? 0;
        const color = SERIES_COLORS[s % SERIES_COLORS.length];
        if (v >= threshold) {
          line += `${color}█${ANSI.reset}`;
        } else if (v > prevThreshold) {
          const frac = (v - prevThreshold) / (threshold - prevThreshold);
          const idx = Math.round(frac * (BLOCKS.length - 1));
          line += `${color}${BLOCKS[idx]}${ANSI.reset}`;
        } else {
          line += " ";
        }
      }
    }
    rows.push(line);
  }

  // Values row
  const valRow = series[0].map((v, p) => {
    if (multiSeries) {
      return series.map((ser) => String(ser[p] ?? 0)).join("/");
    }
    return String(v);
  });
  const maxValLen = Math.max(colsPerPoint, ...valRow.map((v) => v.length));

  // Baseline
  rows.push("  " + "─".repeat(totalCols));
  // Labels (truncated to fit column width)
  const labelRow = labels.map((l) => {
    const width = multiSeries ? colsPerPoint : 1;
    return l.substring(0, width).padEnd(width);
  });
  rows.push("  " + labelRow.join(" "));
  // Value row below labels
  rows.push("  " + valRow.map((v) => {
    const width = multiSeries ? colsPerPoint : 1;
    return `${ANSI.dim}${v.substring(0, Math.max(width, v.length)).padEnd(width)}${ANSI.reset}`;
  }).join(" "));

  // Legend for multi-series
  if (multiSeries) {
    rows.push("");
    const legend = series
      .map((_, s) => {
        const color = SERIES_COLORS[s % SERIES_COLORS.length];
        return `${color}██${ANSI.reset} Series ${s + 1}`;
      })
      .join("  ");
    rows.push(`  ${legend}`);
  }

  const parts: string[] = [];
  if (opts.yAxisLabel) parts.push(`  ${ANSI.dim}${opts.yAxisLabel}${ANSI.reset}`);
  parts.push(...rows);
  if (opts.xAxisLabel) parts.push(`  ${ANSI.dim}${opts.xAxisLabel}${ANSI.reset}`);
  return parts.join("\n");
}

/** Braille dot chart — high-resolution in compact space. */
function renderBraille(opts: ChartOptions): string {
  const values = flatSeries(opts.data);
  if (values.length === 0) return "(no data)";

  const min = values.reduce((a, b) => Math.min(a, b), Infinity);
  const max = values.reduce((a, b) => Math.max(a, b), -Infinity);
  const height = opts.height ?? 8;

  // Braille: each character is a 2×4 dot matrix (2 cols, 4 rows)
  // We map pairs of data points into braille columns
  const rows = height * 4; // dot rows
  const grid: boolean[][] = Array.from({ length: rows }, () =>
    Array(values.length).fill(false) as boolean[]
  );

  // Plot points
  for (let x = 0; x < values.length; x++) {
    const y = Math.round(normalize(values[x], min, max) * (rows - 1));
    // Invert Y (row 0 = top)
    grid[rows - 1 - y][x] = true;
  }

  // Encode to braille characters (each char = 2 cols × 4 rows)
  const charCols = Math.ceil(values.length / 2);
  const charRows = Math.ceil(rows / 4);
  const BRAILLE_BASE = 0x2800;
  // Braille dot numbering for a 2×4 cell:
  // Col 0: dots 1,2,3,7 (bits 0,1,2,6)
  // Col 1: dots 4,5,6,8 (bits 3,4,5,7)
  const DOT_MAP = [
    [0x01, 0x02, 0x04, 0x40], // column 0: rows 0-3
    [0x08, 0x10, 0x20, 0x80], // column 1: rows 0-3
  ];

  const lines: string[] = [];
  for (let cr = 0; cr < charRows; cr++) {
    let line = "";
    for (let cc = 0; cc < charCols; cc++) {
      let code = BRAILLE_BASE;
      for (let dc = 0; dc < 2; dc++) {
        const x = cc * 2 + dc;
        if (x >= values.length) continue;
        for (let dr = 0; dr < 4; dr++) {
          const y = cr * 4 + dr;
          if (!grid[y]?.[x]) continue;
          if (grid[y]?.[x]) {
            code |= DOT_MAP[dc][dr];
          }
        }
      }
      line += String.fromCharCode(code);
    }
    lines.push("  " + line);
  }

  const parts: string[] = [];
  if (opts.yAxisLabel) parts.push(`  ${opts.yAxisLabel}`);
  parts.push(...lines);
  if (opts.xAxisLabel) parts.push(`  ${opts.xAxisLabel}`);
  return parts.join("\n");
}

/** Escape special characters for safe SVG text content. */
function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** SVG line chart — raw SVG string for downstream rendering. */
function renderSvg(opts: ChartOptions): string {
  const values = flatSeries(opts.data);
  if (values.length === 0) return "<svg></svg>";

  const W = 600;
  const H = 300;
  const PAD = 40;
  const min = values.reduce((a, b) => Math.min(a, b), Infinity);
  const max = values.reduce((a, b) => Math.max(a, b), -Infinity);
  const xStep = values.length > 1 ? (W - PAD * 2) / (values.length - 1) : 0;

  const points = values
    .map((v, i) => {
      const x = PAD + i * xStep;
      const y = H - PAD - normalize(v, min, max) * (H - PAD * 2);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");

  const svgParts = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">`,
    `  <rect width="${W}" height="${H}" fill="#1a1a2e"/>`,
    // Axes
    `  <line x1="${PAD}" y1="${PAD}" x2="${PAD}" y2="${H - PAD}" stroke="#555" stroke-width="1"/>`,
    `  <line x1="${PAD}" y1="${H - PAD}" x2="${W - PAD}" y2="${H - PAD}" stroke="#555" stroke-width="1"/>`,
    // Data line
    `  <polyline points="${points}" fill="none" stroke="#00d4ff" stroke-width="2"/>`,
  ];

  // Axis labels
  if (opts.xAxisLabel) {
    svgParts.push(
      `  <text x="${W / 2}" y="${H - 8}" text-anchor="middle" fill="#aaa" font-size="12">${escapeXml(opts.xAxisLabel)}</text>`
    );
  }
  if (opts.yAxisLabel) {
    svgParts.push(
      `  <text x="12" y="${H / 2}" text-anchor="middle" fill="#aaa" font-size="12" transform="rotate(-90,12,${H / 2})">${escapeXml(opts.yAxisLabel)}</text>`
    );
  }

  svgParts.push("</svg>");
  return svgParts.join("\n");
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

const RENDERERS: Record<ChartType, (opts: ChartOptions) => string> = {
  ascii: renderAscii,
  spark: renderSpark,
  bars: renderBars,
  columns: renderColumns,
  braille: renderBraille,
  svg: renderSvg,
};

/**
 * Render a chart from numeric data.
 *
 * @returns The rendered chart as a plain-text or SVG string.
 */
export function renderChart(opts: ChartOptions): string {
  const renderer = RENDERERS[opts.chartType];
  if (!renderer) {
    return `Unknown chart type "${opts.chartType}". Supported: ${Object.keys(RENDERERS).join(", ")}`;
  }
  return renderer(opts);
}
