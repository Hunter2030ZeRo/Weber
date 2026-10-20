import { defineApp } from "@weber/runtime";
import "./style.css";
// Browser globals and native CSS bindings are ready before module evaluation.
const moduleDocument = document;
const marker = document.createElement("span"); marker.style.width = "3px";
const moduleTimeOrigin = performance.timeOrigin;
defineApp({ title: "Notes · Weber", mount(root) {
  const main = document.createElement("main"), heading = document.createElement("h1"), input = document.createElement("input"), button = document.createElement("button"), list = document.createElement("ul");
  heading.textContent = "Notes"; input.id = "note"; button.id = "add"; button.textContent = "Add"; list.id = "notes";
  button.addEventListener("click", () => { if (input.value) { const row = document.createElement("li"); row.textContent = input.value; list.appendChild(row); input.value = ""; } });
  main.append(heading, input, button, list); root.appendChild(main);
  return () => main.remove();
}, test() {
  if (document !== moduleDocument || marker.ownerDocument !== document || marker.style.width !== "3px" || performance.timeOrigin !== moduleTimeOrigin) throw new Error("Module initialization environment changed: " + [document === moduleDocument, marker.ownerDocument === document, marker.style.width, performance.timeOrigin, moduleTimeOrigin].join(","));
  const input = document.getElementById("note") as HTMLInputElement;
  input.value = "First note"; document.getElementById("add")!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  if (document.getElementById("notes")!.textContent !== "First note" || input.value !== "") throw new Error("Notes application failed");
  return { passed: true, note: document.getElementById("notes")!.textContent, moduleDomReady: true, moduleClockStable: true };
} });
