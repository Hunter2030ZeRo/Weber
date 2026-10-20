interface UserApp { mount(root: HTMLElement): void; unmount(): void }
declare global { var WeberUserApp: UserApp; }

/** Used only by Vite's development HTML; packaged apps use the native bootstrap. */
export function mount() {
  const root = document.getElementById('aot-dom-root');
  if (!root || !globalThis.WeberUserApp) throw new Error('Weber application entry did not define an app');
  globalThis.WeberUserApp.mount(root);
}
