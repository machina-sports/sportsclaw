/**
 * sportsclaw — ANSI Color Utilities
 *
 * Minimal color helpers for terminal output.
 * Respects NO_COLOR environment variable.
 */

const NO_COLOR = !!process.env.NO_COLOR;

/**
 * ANSI color codes.
 * Only applied when NO_COLOR is not set.
 */
export const c = {
  green: (s: string) => (NO_COLOR ? s : `\x1b[32m${s}\x1b[0m`),
  red: (s: string) => (NO_COLOR ? s : `\x1b[31m${s}\x1b[0m`),
  yellow: (s: string) => (NO_COLOR ? s : `\x1b[33m${s}\x1b[0m`),
  cyan: (s: string) => (NO_COLOR ? s : `\x1b[36m${s}\x1b[0m`),
  dim: (s: string) => (NO_COLOR ? s : `\x1b[2m${s}\x1b[0m`),
  bold: (s: string) => (NO_COLOR ? s : `\x1b[1m${s}\x1b[0m`),
};

/**
 * Unicode box-drawing characters for tables.
 */
export const box = {
  topLeft: "┌",
  topRight: "┐",
  bottomLeft: "└",
  bottomRight: "┘",
  horizontal: "─",
  vertical: "│",
  leftTee: "├",
  rightTee: "┤",
  topTee: "┬",
  bottomTee: "┴",
  cross: "┼",
};
