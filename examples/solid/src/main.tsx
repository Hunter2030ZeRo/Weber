import { createSignal } from "solid-js";
import { defineSolidApp } from "@weber/solid";
import "./style.css";
export default function Counter() {
  const [count, setCount] = createSignal(0);
  const [name, setName] = createSignal("");
  return <main><h1>Counter</h1><button id="counter" onClick={() => setCount(count() + 1)}>Count: {count()}</button>
    <input id="name" value={name()} onInput={event => setName(event.currentTarget.value)} placeholder="Your name" />
    <output id="greeting">{name()}</output><div id="indicator" style={{ width: `${20 + count()}px`, height: "12px", "background-color": "tomato" }} /></main>;
}
defineSolidApp(Counter, { title: "Counter · Weber", test() {
  const button = document.getElementById("counter")!;
  button.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  button.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  const input = document.getElementById("name") as HTMLInputElement;
  input.value = "가나다"; input.dispatchEvent(new InputEvent("input", { bubbles: true, data: "가나다", inputType: "insertText" }));
  const width = (document.getElementById("indicator") as HTMLElement).style.width;
  if (button.textContent !== "Count: 2" || document.getElementById("greeting")!.textContent !== "가나다" || width !== "22px") throw new Error("Counter application failed");
  return { passed: true, count: 2, text: "가나다", width };
} });
