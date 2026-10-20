import { render, restoreDelegates } from "./aot-web";
import { DesktopApp } from "./desktop-app";
export { mutate, retain, reinsert, releaseRetained } from "./desktop-workload";
let dispose: (() => void) | undefined;
export function mount() { unmount(); restoreDelegates(); dispose = render(() => <DesktopApp />, document.body); }
export function unmount() { dispose?.(); dispose = undefined; }
