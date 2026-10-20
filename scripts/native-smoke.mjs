import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
process.chdir(root);
mkdirSync("artifacts", { recursive: true });
const children = [];
const env = { ...process.env, WINIT_UNIX_BACKEND: "x11", LIBGL_ALWAYS_SOFTWARE: "1" };
delete env.WAYLAND_DISPLAY;
const xdotool = process.env.XDOTOOL ?? "xdotool";
const results = [];

function start(command, args, name, extra = {}) {
  const log = openSync(`artifacts/${name}.log`, "w");
  const child = spawn(command, args, { env, stdio: ["ignore", log, log], ...extra });
  children.push(child);
  return child;
}

async function until(check, description) {
  const deadline = performance.now() + 30000;
  while (performance.now() < deadline) {
    if (await check()) return;
    await delay(100);
  }
  throw new Error(`Timed out: ${description}`);
}

function xdo(...args) {
  return execFileSync(xdotool, args.map(String), { env, encoding: "utf8" }).trim();
}

try {
  execFileSync("cc", ["-Wall", "-Wextra", "-Werror", "scripts/x11-close.c", "-lX11", "-o", "artifacts/x11-close"]);
  const xvfb = start("Xvfb", ["-displayfd", "3", "-screen", "0", "1280x900x24", "-nolisten", "tcp"], "xvfb", {
    stdio: ["ignore", "ignore", "inherit", "pipe"],
  });
  const display = await new Promise((resolve, reject) => {
    xvfb.once("error", reject);
    xvfb.once("exit", code => reject(new Error(`Xvfb exited: ${code}`)));
    xvfb.stdio[3].once("data", data => resolve(data.toString().trim()));
  });
  env.DISPLAY = `:${display}`;
  const port = process.env.WEBER_TEST_PORT ?? "5187";
  const mode = process.env.WEBER_TEST_MODE ?? "preview";
  assert.ok(mode === "preview" || mode === "dev", "test mode must be preview or dev");
  start(process.execPath, [`${root}/app/node_modules/vite/bin/vite.js`, ...(mode === "preview" ? ["preview"] : []), "--host", "127.0.0.1", "--port", port, "--strictPort"], "preview", { cwd: `${root}/app` });
  const address = `http://127.0.0.1:${port}`;
  await until(async () => {
    try { return (await fetch(address)).ok; }
    catch (error) { if (error instanceof TypeError) return false; throw error; }
  }, "Vite preview");
  const started = performance.now();
  const app = start("target/debug/weber-servo", [address], "native");
  let id = "";
  await until(() => {
    assert.equal(app.exitCode, null, "native process exited");
    try { id = xdo("search", "--name", "^Weber \\|").split("\n")[0]; return Boolean(id); }
    catch (error) { if (error.status === 1) return false; throw error; }
  }, "Solid app title in native window");
  const readyMs = Math.round(performance.now() - started);
  const title = () => xdo("getwindowname", id);
  const frames = () => Number(/frames=(\d+)/.exec(title())?.[1]);
  xdo("windowfocus", "--sync", id);
  await until(() => frames() > 0, "first animation frames before screenshot");
  execFileSync("import", ["-display", env.DISPLAY, "-window", id, "artifacts/initial.png"], { env });
  results.push({ test: "app-ready", readyMs, title: title() });

  // Given the loaded native window, when XTest sends a click, then Solid updates.
  xdo("mousemove", "--window", id, 100, 280, "click", 1);
  await until(() => title().includes("clicks=1"), "native button click");
  results.push({ test: "click", title: title() });
  xdo("key", "Return");
  await until(() => title().includes("clicks=2"), "keyboard button activation");
  results.push({ test: "keyboard-activation", title: title() });

  // Given the input, when native keyboard events arrive, then DOM input echoes them.
  xdo("mousemove", "--window", id, 650, 300, "click", 1);
  xdo("type", "--clearmodifiers", "--delay", 35, "Weber 123");
  await until(() => title().includes("text=Weber 123"), "native text input");
  xdo("key", "BackSpace");
  await until(() => title().includes("text=Weber 12 |"), "native backspace");
  results.push({ test: "input", title: title() });

  // Given the scroll container, when native wheel events arrive, then scrollTop changes.
  xdo("mousemove", "--window", id, 600, 560, "click", "--repeat", 4, "--delay", 80, 5);
  await until(() => Number(/scroll=(\d+)/.exec(title())?.[1]) > 0, "native wheel scrolling");
  results.push({ test: "scroll", title: title() });

  // Given a running animation, when frames advance, then the reported count grows.
  const before = frames();
  await until(() => frames() > before, "requestAnimationFrame advancement");
  execFileSync("import", ["-display", env.DISPLAY, "-window", id, "artifacts/interaction.png"], { env });
  results.push({ test: "animation", before, after: frames() });
  const pixels = () => execFileSync("import", ["-display", env.DISPLAY, "-window", id, "-crop", "660x70+252+392", "rgb:-"], { env });
  const firstPixels = pixels();
  await until(() => !pixels().equals(firstPixels), "CSS animation changes rendered pixels");
  execFileSync("import", ["-display", env.DISPLAY, "-window", id, "artifacts/motion.png"], { env });
  results.push({ test: "css-animation", changedPixels: true });
  xdo("mousemove", "--window", id, 110, 445, "click", 1);
  await until(() => title().includes("moving=false"), "pause animation");
  const paused = frames();
  await delay(800);
  assert.equal(frames(), paused, "paused animation frame counter");
  results.push({ test: "pause", frames: paused });
  results.push({ test: "memory", status: readFileSync(`/proc/${app.pid}/status`, "utf8").split("\n").filter(line => /^(VmRSS|VmHWM|Threads):/.test(line)) });
  xdo("windowsize", id, 720, 800);
  await delay(300);
  execFileSync("import", ["-display", env.DISPLAY, "-window", id, "artifacts/resized.png"], { env });
  results.push({ test: "resize", geometry: xdo("getwindowgeometry", "--shell", id) });
  execFileSync("artifacts/x11-close", [id], { env });
  await until(() => app.exitCode !== null, "native close");
  assert.equal(app.exitCode, 0, "clean native shutdown");
  results.push({ test: "close", exitCode: app.exitCode });
  writeFileSync("artifacts/native-smoke.json", JSON.stringify({ passed: true, results }, null, 2));
  console.log(JSON.stringify({ passed: true, results }, null, 2));
} catch (error) {
  writeFileSync("artifacts/native-smoke.json", JSON.stringify({ passed: false, results, error: String(error) }, null, 2));
  throw error;
} finally {
  for (const child of children.reverse()) {
    if (child.exitCode === null) child.kill("SIGTERM");
  }
}
