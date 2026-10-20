import { build } from "vite";
import solid from "vite-plugin-solid";
import { fileURLToPath } from "node:url";
await build({ configFile: false, root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [solid({ solid: { moduleName: "weber-aot-web" } })],
  resolve: { alias: { "weber-aot-web": fileURLToPath(new URL("src/aot-web.ts", import.meta.url)) } },
  build: { target: "es2020", minify: false, outDir: "../target/solid", emptyOutDir: false,
    lib: { entry: fileURLToPath(new URL("src/aot-solid.tsx", import.meta.url)), name: "WeberSolid", formats: ["iife"], fileName: () => "solid.js" } },
});
