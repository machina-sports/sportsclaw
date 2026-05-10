/**
 * sportsclaw — Chart Rendering Utilities
 *
 * Pure Unicode chart renderers vendored from chartli (github.com/ahmadawais/chartli).
 * Zero npm dependencies. No ANSI escape codes — clean output across all platforms.
 *
 * Vendored renderers: ascii, spark, bars, columns, heatmap, unicode, braille, svg
 * Custom renderer: bracket (tournament bracket tree)
 */

// ---------------------------------------------------------------------------
// Public Types
// ---------------------------------------------------------------------------

export type ChartType =
  | "ascii"
  | "spark"
  | "bars"
  | "columns"
  | "heatmap"
  | "unicode"
  | "braille"
  | "svg"
  | "bracket";

export interface BracketMatch {
  round: number;
  matchIndex: number;
  team1: string;
  team2: string;
  score1?: number;
  score2?: number;
  winner?: 1 | 2;
}

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
  /** Optional labels for each data series. */
  seriesLabels?: string[];
  /** Height in terminal rows (for ascii/braille/columns). Default: 12 */
  height?: number;
  /** Width in characters (for bars/braille/svg). */
  width?: number;
  /** Tournament bracket data (for bracket chart type only). */
  bracketData?: BracketMatch[];
}

// ---------------------------------------------------------------------------
// Vendored: chart-annotations (from chartli)
// ---------------------------------------------------------------------------

interface ChartAnnotations {
  readonly xAxisLabel?: string;
  readonly yAxisLabel?: string;
  readonly xLabels?: ReadonlyArray<string>;
  readonly seriesLabels?: ReadonlyArray<string>;
  readonly showDataLabels?: boolean;
}

function formatValue(value: number): string {
  if (!Number.isFinite(value)) return "";
  if (Number.isInteger(value)) return String(value);
  const abs = Math.abs(value);
  const decimals = abs >= 100 ? 0 : abs >= 10 ? 1 : abs >= 1 ? 2 : 3;
  return Number(value.toFixed(decimals)).toString();
}

function centerText(text: string, width: number): string {
  if (width <= 0) return "";
  if (text.length >= width) return text.slice(0, width);
  const leftPadding = Math.floor((width - text.length) / 2);
  const rightPadding = width - text.length - leftPadding;
  return `${" ".repeat(leftPadding)}${text}${" ".repeat(rightPadding)}`;
}

function buildSparseLabelLine({
  width,
  items,
}: {
  width: number;
  items: ReadonlyArray<{ readonly label: string; readonly center: number }>;
}): string {
  if (width <= 0) return "";
  const chars = Array.from({ length: width }, () => " ");
  for (const item of items) {
    const label = item.label.trim();
    if (!label) continue;
    const unclampedStart = Math.round(item.center - label.length / 2);
    const start = Math.max(0, Math.min(width - label.length, unclampedStart));
    const end = start + label.length;
    let hasCollision = false;
    for (let idx = start; idx < end; idx++) {
      if (chars[idx] !== " ") {
        hasCollision = true;
        break;
      }
    }
    if (hasCollision) continue;
    for (let idx = 0; idx < label.length; idx++) {
      chars[start + idx] = label[idx] ?? " ";
    }
  }
  return chars.join("");
}

// ---------------------------------------------------------------------------
// Vendored: normalize (from chartli)
// ---------------------------------------------------------------------------

interface NormalizeResult {
  readonly data: ReadonlyArray<ReadonlyArray<number>>;
  readonly raw: ReadonlyArray<ReadonlyArray<number>>;
  readonly min: ReadonlyArray<number>;
  readonly max: ReadonlyArray<number>;
}

function normalizeData(
  rawRows: ReadonlyArray<ReadonlyArray<number>>
): NormalizeResult {
  if (rawRows.length === 0) return { data: [], raw: [], min: [], max: [] };
  const numCols = rawRows[0]?.length ?? 0;
  const columns: number[][] = Array.from({ length: numCols }, (_, colIdx) =>
    rawRows.map((row) => row[colIdx] ?? 0)
  );
  const minVals = columns.map((col) => Math.min(...col));
  const maxVals = columns.map((col) => Math.max(...col));
  const deltas = columns.map((_, i) => (maxVals[i] ?? 0) - (minVals[i] ?? 0));

  const normalizedCols = columns.map((col, i) => {
    const delta = deltas[i] ?? 0;
    const minV = minVals[i] ?? 0;
    return col.map((v) => (delta === 0 ? 0 : (v - minV) / delta));
  });

  const sortedDeltas = [...deltas]
    .map((d, i) => ({ delta: d, colIdx: i }))
    .sort((a, b) => b.delta - a.delta);

  const scaledCols = normalizedCols.map((col) => [...col]);
  let k = 0;
  let prevDelta = -1;
  for (const { delta, colIdx } of sortedDeltas) {
    if (prevDelta !== -1 && prevDelta.toFixed(3) !== delta.toFixed(3)) {
      k++;
    }
    const scale = (numCols + 2 - k) / (numCols + 2);
    if (scale !== 1) {
      const col = scaledCols[colIdx];
      if (col) {
        for (let j = 0; j < col.length; j++) {
          col[j] = (col[j] ?? 0) * scale;
        }
      }
    }
    prevDelta = delta;
  }

  const numRows = rawRows.length;
  const data = Array.from({ length: numRows }, (_, rowIdx) =>
    Array.from(
      { length: numCols },
      (__, colIdx) => scaledCols[colIdx]?.[rowIdx] ?? 0
    )
  );
  return {
    data,
    raw: rawRows.map((row) => [...row]),
    min: minVals,
    max: maxVals,
  };
}

// ---------------------------------------------------------------------------
// Data Adapter — series-oriented → row-oriented
// ---------------------------------------------------------------------------

/**
 * Transpose our API's series-oriented data into chartli's row-oriented format.
 *
 * - `[10, 20, 30]` → `[[10], [20], [30]]` for time-series charts
 * - `[10, 20, 30]` + bars/columns → `[[10, 20, 30]]` (one row, N columns = N category bars)
 * - `[[10,20],[5,15]]` → `[[10,5], [20,15]]` (multi-series transpose)
 */
function toChartliRows(
  data: number[] | number[][],
  chartType: ChartType,
  annotations: ChartAnnotations
): { rows: number[][]; annotations: ChartAnnotations } {
  if (data.length === 0) return { rows: [], annotations };

  const isMulti = Array.isArray(data[0]);
  const isCategoryChart = chartType === "bars" || chartType === "columns";

  if (isMulti) {
    // Multi-series: each sub-array is one series. Transpose to rows.
    const series = data as number[][];
    const maxLen = Math.max(...series.map((s) => s.length));
    const rows: number[][] = [];
    for (let i = 0; i < maxLen; i++) {
      rows.push(series.map((s) => s[i] ?? 0));
    }
    return { rows, annotations };
  }

  const flat = data as number[];

  if (isCategoryChart) {
    // For bars/columns with single series: one row with N columns = N category bars.
    // Map xLabels → seriesLabels (chartli uses column labels for bar names).
    const updatedAnnotations = { ...annotations };
    if (annotations.xLabels && !annotations.seriesLabels) {
      updatedAnnotations.seriesLabels = annotations.xLabels;
    }
    return { rows: [flat], annotations: updatedAnnotations };
  }

  // Time-series: each value is a data point → one row per point, one column.
  return { rows: flat.map((v) => [v]), annotations };
}

// ---------------------------------------------------------------------------
// Vendored Renderers (from chartli — pure Unicode, no ANSI)
// ---------------------------------------------------------------------------

// -- ASCII (line chart with scatter symbols) --------------------------------

function tryPlaceCenteredText(
  grid: string[][],
  rowIndex: number,
  label: string,
  center: number
): boolean {
  const row = grid[rowIndex];
  if (!row || !label) return false;
  const unclampedStart = Math.round(center - label.length / 2);
  const start = Math.max(0, Math.min(row.length - label.length, unclampedStart));
  if (start < 0 || start + label.length > row.length) return false;
  for (let idx = 0; idx < label.length; idx++) {
    if (row[start + idx] !== " ") return false;
  }
  for (let idx = 0; idx < label.length; idx++) {
    row[start + idx] = label[idx] ?? " ";
  }
  return true;
}

function renderAscii(normalized: NormalizeResult, options?: ChartAnnotations & { width?: number; height?: number }): string {
  const width = options?.width ?? 60;
  const height = options?.height ?? 15;
  const { data, raw, min, max } = normalized;
  const numCols = data[0]?.length ?? 0;
  const numRows = data.length;

  if (numCols === 0 || numRows === 0) return "(no data)";

  const grid: string[][] = Array.from({ length: height }, () =>
    Array(width).fill(" ") as string[]
  );
  const colChars = ["●", "○", "◆", "◇", "▲"];

  for (let colIdx = 0; colIdx < numCols; colIdx++) {
    const char = colChars[colIdx % colChars.length] ?? "●";
    for (let rowIdx = 0; rowIdx < numRows; rowIdx++) {
      const y = data[rowIdx]?.[colIdx] ?? 0;
      const x = Math.floor((rowIdx / Math.max(numRows - 1, 1)) * (width - 1));
      const yPos = height - 1 - Math.floor(y * (height - 1));
      const safeY = Math.max(0, Math.min(height - 1, yPos));
      const safeX = Math.max(0, Math.min(width - 1, x));
      if (grid[safeY] && grid[safeY][safeX] !== undefined) {
        grid[safeY]![safeX] = char;
      }

      if (options?.showDataLabels) {
        const label = formatValue(raw[rowIdx]?.[colIdx] ?? 0);
        const candidateRows = [safeY - 1, safeY + 1, safeY - 2];
        for (const labelRow of candidateRows) {
          if (labelRow >= 0 && labelRow < height && tryPlaceCenteredText(grid, labelRow, label, safeX)) {
            break;
          }
        }
      }
    }
  }

  const tickLabels =
    numCols === 1
      ? [formatValue(max[0] ?? 1), formatValue(((max[0] ?? 1) + (min[0] ?? 0)) / 2), formatValue(min[0] ?? 0)]
      : ["1.00", "0.50", "0.00"];
  const yAxisWidth = Math.max(6, ...tickLabels.map((l) => l.length));
  const lines = grid.map((row, i) => {
    const label =
      i === 0 ? tickLabels[0] ?? "" : i === Math.floor(height / 2) ? tickLabels[1] ?? "" : i === height - 1 ? tickLabels[2] ?? "" : "";
    return `${label.padStart(yAxisWidth)} │${row.join("")}`;
  });

  if (numCols > 1 && (options?.seriesLabels?.length ?? 0) > 0 && options?.seriesLabels) {
    const legend = options.seriesLabels
      .slice(0, numCols)
      .map((l, i) => `${l}=${colChars[i % colChars.length] ?? "●"}`)
      .join("  ");
    lines.unshift(`${" ".repeat(yAxisWidth + 2)}${legend}`);
  }

  if (options?.yAxisLabel) {
    lines.unshift(`${" ".repeat(yAxisWidth + 2)}${options.yAxisLabel}`);
  }

  lines.push(`${" ".repeat(yAxisWidth)} └${"─".repeat(width)}`);

  if (options?.xLabels && numRows > 0) {
    lines.push(
      `${" ".repeat(yAxisWidth + 2)}${buildSparseLabelLine({
        width,
        items: options.xLabels.map((l, i) => ({
          label: l,
          center: numRows === 1 ? 0 : (i / Math.max(numRows - 1, 1)) * (width - 1),
        })),
      })}`
    );
  }

  if (options?.xAxisLabel) {
    lines.push(`${" ".repeat(yAxisWidth + 2)}${centerText(options.xAxisLabel, width)}`);
  }

  return lines.join("\n");
}

// -- Spark (compact sparkline) ----------------------------------------------

const SPARK_BLOCKS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"] as const;

function toSpark(v: number): string {
  const idx = Math.max(0, Math.min(SPARK_BLOCKS.length - 1, Math.round(v * 7)));
  return SPARK_BLOCKS[idx] ?? "▁";
}

function renderSpark(normalized: NormalizeResult, options?: ChartAnnotations): string {
  const { data, raw } = normalized;
  const numCols = data[0]?.length ?? 0;
  const numRows = data.length;
  if (numCols === 0 || numRows === 0) return "(no data)";

  const seriesLabels = options?.seriesLabels ?? [];
  const labelWidth = Math.max(
    0,
    ...Array.from({ length: numCols }, (_, colIdx) => (seriesLabels[colIdx] ?? `S${colIdx + 1}`).length)
  );

  const lines: string[] = [];
  if (options?.yAxisLabel) lines.push(options.yAxisLabel);

  for (let colIdx = 0; colIdx < numCols; colIdx++) {
    const series = data.map((row) => toSpark(row[colIdx] ?? 0)).join("");
    const label = seriesLabels[colIdx] ?? `S${colIdx + 1}`;
    const rawLastValue = raw[raw.length - 1]?.[colIdx];
    const suffix = rawLastValue !== undefined ? ` ${formatValue(rawLastValue)}` : "";
    lines.push(`${label.padEnd(labelWidth)} ${series}${suffix}`);
  }

  if (options?.xLabels && numRows > 0) {
    const prefix = " ".repeat(labelWidth + 1);
    lines.push(
      `${prefix}${buildSparseLabelLine({
        width: numRows,
        items: options.xLabels.map((l, i) => ({
          label: l,
          center: numRows === 1 ? 0 : (i / Math.max(numRows - 1, 1)) * (numRows - 1),
        })),
      })}`
    );
  }

  if (options?.xAxisLabel) {
    lines.push(centerText(options.xAxisLabel, labelWidth + 1 + numRows));
  }

  return lines.join("\n");
}

// -- Bars (horizontal bar chart) --------------------------------------------

const BAR_CHARS = ["█", "▓", "▒", "░", "■", "□"] as const;

function renderBars(normalized: NormalizeResult, options?: ChartAnnotations & { width?: number }): string {
  const width = options?.width ?? 28;
  const { data, raw } = normalized;
  const numCols = data[0]?.length ?? 0;
  const lastRow = data[data.length - 1] ?? [];
  const rawLastRow = raw[raw.length - 1] ?? [];

  if (numCols === 0) return "(no data)";

  const labels = options?.seriesLabels ?? [];
  const labelWidth = Math.max(
    0,
    ...Array.from({ length: numCols }, (_, colIdx) => (labels[colIdx] ?? `S${colIdx + 1}`).length)
  );
  const formattedValues = Array.from({ length: numCols }, (_, colIdx) =>
    formatValue(rawLastRow[colIdx] ?? 0)
  );
  const lines = Array.from({ length: numCols }, (_, colIdx) => {
    const value = Math.max(0, Math.min(1, lastRow[colIdx] ?? 0));
    const units = Math.round(value * width);
    const char = BAR_CHARS[colIdx % BAR_CHARS.length] ?? "█";
    const bar = char.repeat(units).padEnd(width, " ");
    const label = labels[colIdx] ?? `S${colIdx + 1}`;
    const dataLabel = formattedValues[colIdx] ?? value.toFixed(2);
    return `${label.padEnd(labelWidth)} |${bar}| ${dataLabel}`;
  });

  if (options?.yAxisLabel) lines.unshift(options.yAxisLabel);

  if (options?.xAxisLabel) {
    const chartLineWidth = labelWidth + 3 + width + 3 + Math.max(...formattedValues.map((v) => v.length));
    lines.push(centerText(options.xAxisLabel, Math.max(chartLineWidth, options.xAxisLabel.length)));
  }

  return lines.join("\n");
}

// -- Columns (vertical column chart) ----------------------------------------

const COLUMN_CHARS = ["█", "▓", "▒", "░", "■", "□"] as const;

function renderColumns(normalized: NormalizeResult, options?: ChartAnnotations & { height?: number }): string {
  const height = options?.height ?? 8;
  const { data, raw } = normalized;
  const numCols = data[0]?.length ?? 0;
  const lastRow = data[data.length - 1] ?? [];
  const rawLastRow = raw[raw.length - 1] ?? [];

  if (numCols === 0) return "(no data)";

  const labels =
    options?.seriesLabels ?? Array.from({ length: numCols }, (_, i) => String(i + 1));
  const valueLabels = Array.from({ length: numCols }, (_, colIdx) =>
    formatValue(rawLastRow[colIdx] ?? 0)
  );
  const slotWidth = Math.max(1, ...labels.map((l) => l.length), ...valueLabels.map((l) => l.length));
  const totalWidth = numCols * slotWidth + Math.max(0, numCols - 1);
  const lines: string[] = [];

  if (options?.yAxisLabel) lines.push(options.yAxisLabel);

  lines.push(valueLabels.map((l) => centerText(l, slotWidth)).join(" "));

  for (let level = height; level >= 1; level--) {
    const cells: string[] = [];
    for (let colIdx = 0; colIdx < numCols; colIdx++) {
      const value = Math.max(0, Math.min(1, lastRow[colIdx] ?? 0));
      const filled = Math.round(value * height) >= level;
      const char = filled ? (COLUMN_CHARS[colIdx % COLUMN_CHARS.length] ?? "█") : " ";
      cells.push(centerText(char, slotWidth));
    }
    lines.push(cells.join(" "));
  }

  lines.push("─".repeat(Math.max(1, totalWidth)));
  lines.push(labels.map((l) => centerText(l, slotWidth)).join(" "));

  if (options?.xAxisLabel) {
    lines.push(centerText(options.xAxisLabel, Math.max(totalWidth, options.xAxisLabel.length)));
  }

  return lines.join("\n");
}

// -- Heatmap ----------------------------------------------------------------

const SHADES = [" ", "░", "▒", "▓", "█"] as const;

function toShade(value: number): string {
  const clamped = Math.max(0, Math.min(1, value));
  const idx = Math.round(clamped * (SHADES.length - 1));
  return SHADES[idx] ?? " ";
}

function renderHeatmap(normalized: NormalizeResult, options?: ChartAnnotations): string {
  const { data } = normalized;
  const numCols = data[0]?.length ?? 0;
  if (numCols === 0) return "(no data)";

  const labels = options?.seriesLabels ?? [];
  const header = `    ${Array.from({ length: numCols }, (_, i) => labels[i] ?? `C${i + 1}`).join(" ")}`;
  const rows = data.map((row, rowIdx) => {
    const cells = row.map((v) => toShade(v)).join(" ");
    const rowLabel = options?.xLabels?.[rowIdx] ?? `R${String(rowIdx + 1).padStart(2, "0")}`;
    return `${rowLabel.padEnd(3)} ${cells}`;
  });

  const lines = [header, ...rows];
  if (options?.yAxisLabel) lines.unshift(options.yAxisLabel);
  if (options?.xAxisLabel) lines.push(centerText(options.xAxisLabel, header.length));

  return lines.join("\n");
}

// -- Unicode (block chart) --------------------------------------------------

const UNICODE_BLOCKS = [" ", "▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"] as const;

function renderUnicode(normalized: NormalizeResult, options?: ChartAnnotations): string {
  const { data } = normalized;
  const numCols = data[0]?.length ?? 0;
  const numRows = data.length;
  if (numCols === 0 || numRows === 0) return "(no data)";

  const chartHeight = 8;
  const gap = 2;
  const cols: string[][] = [];

  for (let colIdx = 0; colIdx < numCols; colIdx++) {
    const colLines: string[] = [];
    for (let h = chartHeight; h >= 1; h--) {
      let row = "";
      for (let rowIdx = 0; rowIdx < numRows; rowIdx++) {
        const y = data[rowIdx]?.[colIdx] ?? 0;
        const filled = y * chartHeight;
        const blockIdx = Math.min(8, Math.max(0, Math.round((filled - (h - 1)) * 8)));
        row += UNICODE_BLOCKS[blockIdx] ?? " ";
      }
      colLines.push(row);
    }
    cols.push(colLines);
  }

  const mergedLines =
    cols[0]?.map((_, lineIdx) => cols.map((col) => col[lineIdx] ?? "").join(" ".repeat(gap))) ?? [];
  const totalWidth = numCols * numRows + Math.max(0, numCols - 1) * gap;
  const lines: string[] = [];

  if (options?.yAxisLabel) lines.push(options.yAxisLabel);

  if (options?.seriesLabels && numCols > 0) {
    lines.push(
      buildSparseLabelLine({
        width: totalWidth,
        items: options.seriesLabels.slice(0, numCols).map((l, colIdx) => ({
          label: l,
          center: colIdx * (numRows + gap) + Math.max(0, (numRows - 1) / 2),
        })),
      })
    );
  }

  lines.push(...mergedLines);

  if (options?.xLabels && numCols === 1) {
    lines.push(
      buildSparseLabelLine({
        width: numRows,
        items: options.xLabels.map((l, i) => ({ label: l, center: i })),
      })
    );
  }

  if (options?.xAxisLabel) {
    lines.push(centerText(options.xAxisLabel, Math.max(totalWidth, options.xAxisLabel.length)));
  }

  return lines.join("\n");
}

// -- Braille (dot plot) -----------------------------------------------------

const DOT_BIT: ReadonlyArray<number> = [0x01, 0x02, 0x04, 0x40, 0x08, 0x10, 0x20, 0x80];

function brailleChar(dots: ReadonlyArray<boolean>): string {
  let bits = 0;
  for (let i = 0; i < dots.length; i++) {
    if (dots[i]) bits |= DOT_BIT[i] ?? 0;
  }
  return String.fromCodePoint(0x2800 + bits);
}

function renderBraille(normalized: NormalizeResult, options?: ChartAnnotations & { width?: number; height?: number }): string {
  const { data } = normalized;
  const numRows = data.length;
  const numCols = data[0]?.length ?? 0;
  if (numCols === 0 || numRows === 0) return "(no data)";

  const charWidth = options?.width ?? 40;
  const charHeight = options?.height ?? 8;
  const dotWidth = charWidth * 2;
  const dotHeight = charHeight * 4;

  const lines: string[] = [];
  if (options?.yAxisLabel) {
    lines.push(options.yAxisLabel);
    lines.push("");
  }

  for (let colIdx = 0; colIdx < numCols; colIdx++) {
    const dotGrid: boolean[][] = Array.from({ length: dotHeight }, () =>
      new Array(dotWidth).fill(false) as boolean[]
    );

    if (options?.seriesLabels?.[colIdx]) {
      if (lines.length > 0) lines.push("");
      lines.push(options.seriesLabels[colIdx] ?? "");
    }

    for (let rowIdx = 0; rowIdx < numRows; rowIdx++) {
      const y = data[rowIdx]?.[colIdx] ?? 0;
      const dotX = Math.floor((rowIdx / Math.max(numRows - 1, 1)) * (dotWidth - 1));
      const dotY = dotHeight - 1 - Math.floor(y * (dotHeight - 1));
      const safeY = Math.max(0, Math.min(dotHeight - 1, dotY));
      const safeX = Math.max(0, Math.min(dotWidth - 1, dotX));
      if (dotGrid[safeY] && dotGrid[safeY][safeX] !== undefined) {
        dotGrid[safeY]![safeX] = true;
      }
    }

    if (colIdx > 0) lines.push("");

    for (let cy = 0; cy < charHeight; cy++) {
      let rowStr = "";
      for (let cx = 0; cx < charWidth; cx++) {
        const dots: boolean[] = [
          dotGrid[cy * 4 + 0]?.[cx * 2 + 0] ?? false,
          dotGrid[cy * 4 + 1]?.[cx * 2 + 0] ?? false,
          dotGrid[cy * 4 + 2]?.[cx * 2 + 0] ?? false,
          dotGrid[cy * 4 + 3]?.[cx * 2 + 0] ?? false,
          dotGrid[cy * 4 + 0]?.[cx * 2 + 1] ?? false,
          dotGrid[cy * 4 + 1]?.[cx * 2 + 1] ?? false,
          dotGrid[cy * 4 + 2]?.[cx * 2 + 1] ?? false,
          dotGrid[cy * 4 + 3]?.[cx * 2 + 1] ?? false,
        ];
        rowStr += brailleChar(dots);
      }
      lines.push(rowStr);
    }
  }

  if (options?.xAxisLabel) {
    lines.push("");
    lines.push(centerText(options.xAxisLabel, Math.max(charWidth, options.xAxisLabel.length)));
  }

  return lines.join("\n");
}

// -- SVG (vector chart) -----------------------------------------------------

const SVG_COLORS = ["#0072B2", "#F0E442", "#009E73", "#CC79A7", "#D55E00", "#eeeeee"] as const;

function getSvgColor(colIdx: number, numCols: number): string {
  if (numCols === 1) return "#eeeeee";
  return SVG_COLORS[colIdx % SVG_COLORS.length] ?? "#eeeeee";
}

function svgPoint(x: number, y: number, plotWidth: number, plotHeight: number, leftMargin: number, topMargin: number): string {
  const px = x * plotWidth + leftMargin;
  const py = topMargin + plotHeight - y * plotHeight;
  return `${Math.round(px)},${Math.round(py)}`;
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/'/g, "&apos;").replace(/"/g, "&quot;");
}

function renderSvg(normalized: NormalizeResult, options?: ChartAnnotations & { width?: number; height?: number }): string {
  const plotWidth = options?.width ?? 320;
  const plotHeight = options?.height ?? 120;
  const seriesLabels = options?.seriesLabels ?? [];
  const numCols = normalized.data[0]?.length ?? 0;
  const showLegend = numCols > 1 && seriesLabels.length > 0;

  const leftMargin = options?.yAxisLabel ? 56 : 44;
  const topMargin = 12;
  const bottomMargin = options?.xAxisLabel || options?.xLabels?.length ? 42 : 24;
  const gutter = 30;
  const legendWidth = showLegend ? 300 : 0;
  const lineHeight = 20;
  const fontSize = 15;

  const { data, min, max } = normalized;
  const totalWidth = leftMargin + plotWidth + (showLegend ? gutter + legendWidth : 24);
  const totalHeight = topMargin + plotHeight + bottomMargin;
  const axisX = leftMargin;
  const axisY = topMargin + plotHeight;
  const yTickLabels =
    numCols === 1
      ? [formatValue(max[0] ?? 1), formatValue(((max[0] ?? 1) + (min[0] ?? 0)) / 2), formatValue(min[0] ?? 0)]
      : ["1.00", "0.50", "0.00"];

  const lines: string[] = [
    `<?xml version='1.0'?>`,
    `<svg xmlns='http://www.w3.org/2000/svg' width='${totalWidth}' height='${totalHeight}' version='1.1'>`,
    `  <rect width='100%' height='100%' fill='#111111'/>`,
    `  <line x1='${axisX}' y1='${topMargin}' x2='${axisX}' y2='${axisY}' stroke='#666666' stroke-width='1'/>`,
    `  <line x1='${axisX}' y1='${axisY}' x2='${axisX + plotWidth}' y2='${axisY}' stroke='#666666' stroke-width='1'/>`,
  ];

  const yTickYPositions = [topMargin, topMargin + plotHeight / 2, axisY];
  for (let i = 0; i < yTickLabels.length; i++) {
    const tickY = Math.round(yTickYPositions[i] ?? axisY);
    lines.push(`  <line x1='${axisX - 4}' y1='${tickY}' x2='${axisX}' y2='${tickY}' stroke='#999999' stroke-width='1'/>`);
    lines.push(`  <text x='${axisX - 8}' y='${tickY + 4}' fill='#eeeeee' font-size='11' font-family='mono' text-anchor='end'>${escapeXml(yTickLabels[i] ?? "")}</text>`);
  }

  if (options?.yAxisLabel) {
    lines.push(`  <text x='18' y='${topMargin + plotHeight / 2}' fill='#eeeeee' font-size='12' font-family='mono' text-anchor='middle' transform='rotate(-90 18 ${topMargin + plotHeight / 2})'>${escapeXml(options.yAxisLabel)}</text>`);
  }

  for (let colIdx = 0; colIdx < numCols; colIdx++) {
    const color = getSvgColor(colIdx, numCols);
    const points = data
      .map((_, rowIdx) => {
        const y = data[rowIdx]?.[colIdx] ?? 0;
        return svgPoint(rowIdx / Math.max(data.length - 1, 1), y, plotWidth, plotHeight, leftMargin, topMargin);
      })
      .join(" ");
    lines.push(`  <polyline stroke='${color}ff' stroke-width='1.5' fill='none' points='${points}'/>`);
  }

  if (options?.xLabels) {
    for (let rowIdx = 0; rowIdx < options.xLabels.length; rowIdx++) {
      const x = leftMargin + Math.round((rowIdx / Math.max(options.xLabels.length - 1, 1)) * plotWidth);
      lines.push(`  <text x='${x}' y='${axisY + 16}' fill='#eeeeee' font-size='11' font-family='mono' text-anchor='middle'>${escapeXml(options.xLabels[rowIdx] ?? "")}</text>`);
    }
  }

  if (options?.xAxisLabel) {
    lines.push(`  <text x='${leftMargin + plotWidth / 2}' y='${totalHeight - 8}' fill='#eeeeee' font-size='12' font-family='mono' text-anchor='middle'>${escapeXml(options.xAxisLabel)}</text>`);
  }

  if (showLegend) {
    const legendX = leftMargin + plotWidth + gutter;
    for (let colIdx = 0; colIdx < numCols; colIdx++) {
      const title = seriesLabels[colIdx] ?? `S${colIdx + 1}`;
      const color = getSvgColor(colIdx, numCols);
      lines.push(
        `  <g transform='translate(${legendX} ${topMargin + (colIdx + 1) * lineHeight})'>`,
        `    <circle cx='-10' cy='${-lineHeight / 2 + 5}' r='3.5' fill='${color}' stroke='${color}'/>`,
        `    <text style='fill: #eeeeee; font-size: ${fontSize}px; font-family: mono' xml:space='preserve'>${escapeXml(title)} [${formatValue(min[colIdx] ?? 0)}, ${formatValue(max[colIdx] ?? 0)}]</text>`,
        `  </g>`
      );
    }
  }

  lines.push(`</svg>`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Custom: Bracket (tournament bracket tree)
// ---------------------------------------------------------------------------

function renderBracket(bracketData: BracketMatch[]): string {
  if (!bracketData || bracketData.length === 0) return "(no bracket data)";

  // Group matches by round
  const rounds = new Map<number, BracketMatch[]>();
  for (const m of bracketData) {
    if (!rounds.has(m.round)) rounds.set(m.round, []);
    rounds.get(m.round)!.push(m);
  }

  // Sort rounds and matches within each round
  const roundNums = [...rounds.keys()].sort((a, b) => a - b);
  for (const r of roundNums) {
    rounds.get(r)!.sort((a, b) => a.matchIndex - b.matchIndex);
  }

  // Determine column widths
  const maxTeamLen = Math.max(
    8,
    ...bracketData.map((m) => Math.max(m.team1.length, m.team2.length))
  );
  const scoreWidth = 3; // space for score like " 3"
  const cellWidth = maxTeamLen + scoreWidth;
  const connectorWidth = 5; // " ─── "

  const lines: string[] = [];

  // Calculate total height: first round determines base slot count
  const firstRoundMatches = rounds.get(roundNums[0]!)?.length ?? 0;
  const totalSlots = firstRoundMatches * 4; // 4 rows per match: team1, connector, team2, spacer

  // Build the bracket grid
  const grid: string[][] = Array.from({ length: totalSlots }, () => []);

  for (let ri = 0; ri < roundNums.length; ri++) {
    const roundNum = roundNums[ri]!;
    const matches = rounds.get(roundNum) ?? [];
    const spacing = Math.pow(2, ri); // matches are spaced further apart in later rounds
    const blockHeight = spacing * 4;
    const offset = Math.floor(blockHeight / 2) - 1; // center within block

    for (let mi = 0; mi < matches.length; mi++) {
      const m = matches[mi]!;
      const baseRow = mi * blockHeight + Math.max(0, offset - 1);

      // Team 1 line
      const score1 = m.score1 !== undefined ? String(m.score1).padStart(2) : "  ";
      const t1Mark = m.winner === 1 ? ">" : " ";
      const team1Line = `${t1Mark}${m.team1.padEnd(maxTeamLen)} ${score1}`;

      // Connector line (shows winner advancing)
      const connector = ri < roundNums.length - 1 ? ` ─── ` : "";
      const connLine = `${"".padEnd(cellWidth + 1)}${connector}`;

      // Team 2 line
      const score2 = m.score2 !== undefined ? String(m.score2).padStart(2) : "  ";
      const t2Mark = m.winner === 2 ? ">" : " ";
      const team2Line = `${t2Mark}${m.team2.padEnd(maxTeamLen)} ${score2}`;

      // Place in grid
      const row1 = baseRow;
      const row2 = baseRow + 1;
      const row3 = baseRow + 2;

      if (row1 < totalSlots) {
        while (grid[row1]!.length < ri) grid[row1]!.push("".padEnd(cellWidth + connectorWidth));
        grid[row1]!.push(team1Line);
      }
      if (row2 < totalSlots) {
        while (grid[row2]!.length < ri) grid[row2]!.push("".padEnd(cellWidth + connectorWidth));
        grid[row2]!.push(connLine);
      }
      if (row3 < totalSlots) {
        while (grid[row3]!.length < ri) grid[row3]!.push("".padEnd(cellWidth + connectorWidth));
        grid[row3]!.push(team2Line);
      }
    }
  }

  // Render grid to lines
  for (const row of grid) {
    const line = row.join("");
    if (line.trim()) lines.push(line);
  }

  // Add round headers
  if (roundNums.length > 1) {
    const roundLabels: string[] = [];
    for (let ri = 0; ri < roundNums.length; ri++) {
      const label = ri === roundNums.length - 1 ? "Final" : ri === roundNums.length - 2 ? "Semis" : `Round ${roundNums[ri]}`;
      roundLabels.push(label.padEnd(cellWidth + connectorWidth));
    }
    lines.unshift(roundLabels.join("").trimEnd());
    lines.unshift("─".repeat(roundLabels.join("").trimEnd().length));
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

type ChartRenderer = (opts: ChartOptions) => string;

const RENDERERS: Record<ChartType, ChartRenderer> = {
  ascii: (opts) => {
    const { rows, annotations } = toChartliRows(opts.data, opts.chartType, toAnnotations(opts));
    if (rows.length === 0) return "(no data)";
    const normalized = normalizeData(rows);
    return renderAscii(normalized, { ...annotations, width: opts.width, height: opts.height });
  },
  spark: (opts) => {
    const { rows, annotations } = toChartliRows(opts.data, opts.chartType, toAnnotations(opts));
    if (rows.length === 0) return "(no data)";
    const normalized = normalizeData(rows);
    return renderSpark(normalized, annotations);
  },
  bars: (opts) => {
    const { rows, annotations } = toChartliRows(opts.data, opts.chartType, toAnnotations(opts));
    if (rows.length === 0) return "(no data)";
    const normalized = normalizeData(rows);
    return renderBars(normalized, { ...annotations, width: opts.width });
  },
  columns: (opts) => {
    const { rows, annotations } = toChartliRows(opts.data, opts.chartType, toAnnotations(opts));
    if (rows.length === 0) return "(no data)";
    const normalized = normalizeData(rows);
    return renderColumns(normalized, { ...annotations, height: opts.height });
  },
  heatmap: (opts) => {
    const { rows, annotations } = toChartliRows(opts.data, opts.chartType, toAnnotations(opts));
    if (rows.length === 0) return "(no data)";
    const normalized = normalizeData(rows);
    return renderHeatmap(normalized, annotations);
  },
  unicode: (opts) => {
    const { rows, annotations } = toChartliRows(opts.data, opts.chartType, toAnnotations(opts));
    if (rows.length === 0) return "(no data)";
    const normalized = normalizeData(rows);
    return renderUnicode(normalized, annotations);
  },
  braille: (opts) => {
    const { rows, annotations } = toChartliRows(opts.data, opts.chartType, toAnnotations(opts));
    if (rows.length === 0) return "(no data)";
    const normalized = normalizeData(rows);
    return renderBraille(normalized, { ...annotations, width: opts.width, height: opts.height });
  },
  svg: (opts) => {
    const { rows, annotations } = toChartliRows(opts.data, opts.chartType, toAnnotations(opts));
    if (rows.length === 0) return "<svg></svg>";
    const normalized = normalizeData(rows);
    return renderSvg(normalized, { ...annotations, width: opts.width, height: opts.height });
  },
  bracket: (opts) => {
    return renderBracket(opts.bracketData ?? []);
  },
};

/** Map ChartOptions to chartli's ChartAnnotations. */
function toAnnotations(opts: ChartOptions): ChartAnnotations {
  return {
    xAxisLabel: opts.xAxisLabel,
    yAxisLabel: opts.yAxisLabel,
    xLabels: opts.xLabels,
    seriesLabels: opts.seriesLabels,
  };
}

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
