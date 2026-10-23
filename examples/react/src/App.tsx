import { useState } from "react";

export default function App() {
  const [count, setCount] = useState(0);
  const [name, setName] = useState("");
  return <main><h1>React Counter</h1>
    <button id="counter" onClick={() => setCount(previous => previous + 1)}>Count: {count}</button>
    <label>Your name <input id="name" value={name} onChange={event => setName(event.currentTarget.value)} /></label>
    <output id="greeting">{name}</output>
    <div id="indicator" style={{ width: `${20 + count}px`, height: "12px", backgroundColor: "tomato" }} />
  </main>;
}
