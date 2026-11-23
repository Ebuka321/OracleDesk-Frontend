/** Tells backend-side trouble apart from network-side trouble by comparing the browser's own probe against the backend's reported probe for the same dependency. */
export function classifyProbeMismatch(browserOk: boolean, backendOk: boolean): "healthy" | "backend" | "network" {
  if (browserOk && backendOk) return "healthy";
  if (browserOk && !backendOk) return "backend";
  return "network";
}
