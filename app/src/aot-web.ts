import { template as nativeTemplate, delegateEvents as nativeDelegateEvents } from "solid-js/web";
export * from "solid-js/web";
const delegated = new Set<string>();
// Solid caches template nodes. Keep that cache local to each document session.
export function template(...args: Parameters<typeof nativeTemplate>) {
  const templates = new WeakMap<Document, ReturnType<typeof nativeTemplate>>();
  const create = () => {
    let factory = templates.get(document);
    if (!factory) { factory = nativeTemplate(...args); templates.set(document, factory); }
    return factory();
  };
  create.cloneNode = create;
  return create;
}
export function delegateEvents(names: string[], target?: Document) {
  for (const name of names) delegated.add(name);
  if (typeof document !== "undefined") nativeDelegateEvents(names, target ?? document);
}
export function restoreDelegates() { nativeDelegateEvents([...delegated], document); }
