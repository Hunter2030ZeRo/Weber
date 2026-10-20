import { build } from "esbuild";
import { fileURLToPath } from "node:url";
await build({ entryPoints: [fileURLToPath(new URL("platform.mjs", import.meta.url))],
  outfile: fileURLToPath(new URL("../target/platform.js", import.meta.url)),
  bundle: true, format: "iife", platform: "browser", target: "es2020" });
