export interface WorkspaceCreationStatus {
  owned_count: number;
  workspace_limit: number;
  trial_available: boolean;
}
export function parseWorkspaceCreationStatus(
  value: unknown,
): WorkspaceCreationStatus {
  const s = value as WorkspaceCreationStatus | null;
  if (
    !s ||
    !Number.isSafeInteger(s.owned_count) ||
    s.owned_count < 0 ||
    s.workspace_limit !== 3 ||
    typeof s.trial_available !== "boolean"
  )
    throw new Error("We could not check workspace availability. Try again.");
  return s;
}
export function workspaceCreationError(error: unknown): string {
  const code = (error as { code?: string })?.code;
  if (code === "42501")
    return "Confirm your email and sign in again before creating a workspace.";
  if (code === "P0001")
    return "You have reached the limit of three owned workspaces. Contact support before adding another business.";
  if (code === "22023") return "Enter a workspace name of 1–200 characters.";
  return "Workspace creation could not be confirmed. Retry to check the same request safely.";
}
