import { render, restoreDelegates } from "./aot-web";
import { CompatibilityApp } from "./compatibility-app";
let dispose: (() => void) | undefined;
export function mount() { restoreDelegates(); dispose = render(() => <CompatibilityApp />, document.body); }
export function unmount() { dispose?.(); dispose = undefined; }
