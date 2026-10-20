import { build } from 'vite';
import solid from 'vite-plugin-solid';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('.', import.meta.url));
for (const mode of process.argv.includes('--web-only') ? ['web'] : ['aot', 'web']) {
  const aot = mode === 'aot';
  await build({ configFile: false, root,
    plugins: [solid(aot ? { solid: { moduleName: 'weber-aot-web' } } : {})],
    resolve: { alias: aot ? { 'weber-aot-web': fileURLToPath(new URL('src/aot-web.ts', import.meta.url)) } : {} },
    build: { target: 'es2020', minify: false, outDir: '../target/desktop', emptyOutDir: false,
      lib: { entry: `${root}/src/${mode}-desktop.tsx`, name: aot ? 'WeberDesktop' : 'WeberDesktopWebBundle', formats: ['iife'], fileName: () => `${mode}.js` } },
  });
}
