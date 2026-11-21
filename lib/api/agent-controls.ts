import { apiClient } from "./client";
import { parseControlsOverview, type ControlsOverview, type PauseInput, type Scope } from "@/lib/admin/agent-controls";

function overviewOrThrow(data: unknown): ControlsOverview {
  const parsed = parseControlsOverview(data);
  if (!parsed) throw new Error("Unexpected agent controls response");
  return parsed;
}

/** `GET /admin/agents/controls` (requires `agents.manage`). */
export async function getAgentControls(options?: { signal?: AbortSignal }): Promise<ControlsOverview> {
  const { data } = await apiClient.get<unknown>("/admin/agents/controls", undefined, options);
  return overviewOrThrow(data);
}

export async function pauseAgent(scope: Scope, input: PauseInput): Promise<ControlsOverview> {
  const { data } = await apiClient.post<unknown>(`/admin/agents/${scope}/pause`, {
    reason: input.reason.trim(),
    ...(input.until ? { until: input.until.toISOString() } : {}),
  });
  return overviewOrThrow(data);
}

export async function resumeAgent(scope: Scope, input: { reason?: string } = {}): Promise<ControlsOverview> {
  const reason = input.reason?.trim();
  const { data } = await apiClient.post<unknown>(`/admin/agents/${scope}/resume`, reason ? { reason } : {});
  return overviewOrThrow(data);
}
