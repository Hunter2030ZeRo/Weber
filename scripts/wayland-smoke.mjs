import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { openSync, readFileSync, writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
process.chdir(root);
assert.ok(process.env.WAYLAND_DISPLAY, "A running Wayland compositor is required");
const domTest = process.env.WEBER_DOM_TEST === "1";
const browserTest = process.env.WEBER_BROWSER_TEST === "1";
const solidTest = process.env.WEBER_SOLID_TEST === "1";
const capture = solidTest ? "artifacts/solid-aot.png" : browserTest ? "artifacts/browser-dom.png" : domTest ? "artifacts/dom-binding.png" : "artifacts/wayland-aot.png";
const env = { ...process.env, RUST_LOG: "info", WEBER_SMOKE_CAPTURE: capture };
delete env.DISPLAY;
const selfTest = execFileSync("target/debug/weber-servo", ["--aot-self-test"], { env, encoding: "utf8" });
const serverLog = openSync("artifacts/wayland-vite.log", "w");
const server = spawn(process.execPath, [`${root}app/node_modules/vite/bin/vite.js`, "preview", "--host", "127.0.0.1", "--port", "5188", "--strictPort"], { cwd: `${root}app`, env, stdio: ["ignore", serverLog, serverLog] });
let app;
try {
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { ready = (await fetch("http://127.0.0.1:5188")).ok; }
    catch (error) { if (!(error instanceof TypeError)) throw error; }
    if (ready) break;
    await delay(100);
  }
  assert.ok(ready, "Vite ready");
  const log = openSync("artifacts/wayland-native.log", "w");
  app = spawn("target/debug/weber-servo", [`http://127.0.0.1:5188/?${solidTest ? "solidTest" : browserTest ? "browserTest" : domTest ? "domTest" : "aotTest"}=1`], { env, stdio: ["ignore", log, log] });
  const exit = await Promise.race([
    new Promise((resolve, reject) => { app.once("error", reject); app.once("exit", (code, signal) => resolve({ code, signal })); }),
    delay(30000, undefined, { ref: false }).then(() => { throw new Error("Wayland DOM/AOT round trip timed out"); }),
  ]);
  assert.equal(exit.code, 0, "native close exits cleanly");
  const output = readFileSync("artifacts/wayland-native.log", "utf8");
  assert.match(output, solidTest ? /Weber Solid AOT PASS sync cancellation/ : browserTest ? /Weber browser DOM PASS contracts=30/ : domTest ? /Weber DOM binding PASS:/ : /aot=3/, "expected DOM state observed in Servo title");
  assert.ok(readFileSync(capture).length > 1000, "Servo rendered screenshot");
  const result = { passed: true, backend: "Wayland (DISPLAY unset)", selfTest: selfTest.trim(), scenario: solidTest ? "Solid TSX native AOT; synchronous cancellation, signals, keyed For; real Servo timeout/interval/rAF, clock origin, pause/resume, post-dispatch microtask checkpoint, scheduled callback disposal and remount" : browserTest ? "30 shared DOM contracts; observer checkpoint ordering and transient cleanup; selectors, HTML parsing, live collections, cloning, CSS, native text/value/event bridge, session disposal" : domTest ? "DOM creation, attributes, text, click/input callbacks, subtree removal, stale listener/session rejection, disposal" : "three AOT round trips", nativeExit: exit.code, input: "programmatic DOM events, not physical input" };
  writeFileSync(solidTest ? "artifacts/solid-aot.json" : browserTest ? "artifacts/browser-dom.json" : domTest ? "artifacts/dom-binding.json" : "artifacts/wayland-aot.json", JSON.stringify(result, null, 2));
  console.log(result);
} finally {
  if (app && app.exitCode === null) app.kill();
  server.kill();
}
