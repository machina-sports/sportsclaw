/**
 * sportsclaw — Model Role Contracts
 *
 * First-class inference roles for the accelerated inference plane:
 *
 *   - `eyes`  — visual perception (e.g. Cosmos 3 Nano Reasoner)
 *   - `brain` — editorial/programming reasoning (e.g. Nemotron 3 Super 120B A12B)
 *   - `hands` — generated video/image asset production (e.g. Cosmos 3 Super I2V)
 *   - `voice` — narration/chyrons/copy (e.g. Nemotron 49B)
 *
 * The abstraction is inference roles, not hardware. Hardware (H200 etc.)
 * lives only in route metadata and benchmark output — never in contract
 * names. The same role contract works for local NIMs, OpenShell, hosted
 * NIM endpoints, or future cloud inference.
 */

export const MODEL_ROLES = ["eyes", "brain", "hands", "voice"] as const;

export type ModelRole = (typeof MODEL_ROLES)[number];

export function isModelRole(value: unknown): value is ModelRole {
  return typeof value === "string" && (MODEL_ROLES as readonly string[]).includes(value);
}
