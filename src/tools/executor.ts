import { sanitizeToolInput } from "../tools.js";
import { classifyFailure } from "../failures/classifier.js";
import type { ClassifiedFailure } from "../failures/types.js";

export interface ToolExecutionResult {
  ok: boolean;
  toolName: string;
  args: Record<string, unknown>;
  data?: unknown;
  warnings: string[];
  failure?: ClassifiedFailure;
  latencyMs?: number;
  normalized: boolean;
}

export async function executeToolSafely(
  toolName: string,
  args: Record<string, unknown>,
  run: (name: string, a: Record<string, unknown>) => Promise<{ content: string; isError?: boolean }>,
  nowFn: () => number = Date.now,
): Promise<ToolExecutionResult> {
  const started = nowFn();
  const normalizedArgs = { ...args };
  const before = JSON.stringify(normalizedArgs);
  sanitizeToolInput(toolName, normalizedArgs);
  const normalized = JSON.stringify(normalizedArgs) !== before;

  try {
    const result = await run(toolName, normalizedArgs);
    if (result.isError) {
      return {
        ok: false, toolName, args: normalizedArgs, warnings: [], normalized,
        failure: classifyFailure(result.content, toolName),
        latencyMs: nowFn() - started,
      };
    }
    return {
      ok: true, toolName, args: normalizedArgs, data: result.content, warnings: [], normalized,
      latencyMs: nowFn() - started,
    };
  } catch (err) {
    return {
      ok: false, toolName, args: normalizedArgs, warnings: [], normalized,
      failure: classifyFailure(err instanceof Error ? err.message : String(err), toolName),
      latencyMs: nowFn() - started,
    };
  }
}
