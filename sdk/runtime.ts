export interface ApplicationOptions {
  title?: string;
  mount(root: HTMLElement): void | (() => void);
  test?(): Record<string, unknown>;
}
export function defineApp(options: ApplicationOptions) {
  if (typeof options.mount !== "function") throw new TypeError("Application mount function is required");
  let dispose: (() => void) | undefined;
  let currentRoot: HTMLElement | undefined;
  const app = {
    mount(root: HTMLElement) {
      app.unmount();
      if (!root || root.nodeType !== 1) throw new TypeError("Application mount root must be an Element");
      currentRoot = root;
      if (options.title) document.title = options.title;
      const result = options.mount(root);
      dispose = typeof result === "function" ? result : undefined;
    },
    unmount() { try { dispose?.(); } finally { dispose = undefined; currentRoot?.replaceChildren(); currentRoot = undefined; } },
    test() { if (!options.test) throw new Error("This application has no test entry"); return options.test(); },
  };
  Object.assign(globalThis, { WeberUserApp: app });
  return app;
}
