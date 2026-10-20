import { createComponent, type JSX } from "solid-js";
import { render, restoreDelegates } from "@weber/dom";
import { defineApp, type ApplicationOptions } from "./runtime";
export function defineSolidApp(component: () => JSX.Element, options: Omit<ApplicationOptions, "mount"> = {}) {
  return defineApp({ ...options, mount(root) { restoreDelegates(); return render(() => createComponent(component, {}), root); } });
}
