import type { ToolSpec, sportsclawConfig } from "../types.js";
import type { ToolRegistry } from "../tools.js";
import type { ToolCallInput, ToolCallResult } from "../bridge.js";

export interface BuiltinTool {
  spec: ToolSpec;
  execute(
    input: ToolCallInput,
    config?: Partial<sportsclawConfig>,
    registry?: ToolRegistry
  ): Promise<ToolCallResult>;
}
