export interface HyprlandSnapshot {
  connected: boolean;
  error: string | null;
  monitors: Array<{ id: number; name: string; activeWorkspace: number; focused: boolean }>;
  workspaces: Array<{ id: number; name: string; monitor: string; windows: number }>;
  clients: Array<{ address: string; title: string; class: string; workspace: number; pid: number }>;
  activeAddress: string;
  truncated: boolean;
}
export interface HyprlandOptions { runtimeDir?: string; instance?: string; timeoutMs?: number }
export function createHyprlandClient(options?: HyprlandOptions): {
  snapshot(options?: { signal?: AbortSignal }): Promise<HyprlandSnapshot>;
  watch(emit: (snapshot: HyprlandSnapshot) => void | Promise<void>, options: { signal: AbortSignal }): Promise<void>;
  focusWorkspace(id: number, options?: { signal?: AbortSignal }): Promise<boolean>;
  focusWindow(address: string, options?: { signal?: AbortSignal }): Promise<boolean>;
};
