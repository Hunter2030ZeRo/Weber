import { spawn } from 'node:child_process';
import { createHyprlandClient } from '@weber/sdk/hyprland';

let client, launcher;
const hyprland = () => client ??= createHyprlandClient();
export default {
  snapshot: (_, { signal }) => hyprland().snapshot({ signal }),
  watch: (_, { signal, emit }) => hyprland().watch(emit, { signal }),
  workspace: (id, { signal }) => hyprland().focusWorkspace(id, { signal }),
  focus: (address, { signal }) => hyprland().focusWindow(address, { signal }),
  launcher() {
    if (launcher && launcher.exitCode === null && launcher.signalCode === null) return { pid: launcher.pid, existing: true };
    if (!process.env.WEBER_HOST_EXECUTABLE || !process.env.WEBER_APP_DIR) throw new Error('Native host executable/application directory missing');
    // Fixed argv and the current compiled app only; no arbitrary shell command.
    launcher = spawn(process.env.WEBER_HOST_EXECUTABLE, ['--app', process.env.WEBER_APP_DIR], { stdio: ['ignore', 'ignore', 'inherit'] });
    return new Promise((resolve, reject) => {
      launcher.once('error', reject);
      launcher.once('spawn', () => resolve({ pid: launcher.pid, existing: false }));
    });
  },
};
