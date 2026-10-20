import { join } from 'node:path';
import { builtinModules } from 'node:module';
import { importTool, root, sdk, checkout, packageDirectory } from './toolchain.mjs';

/** Vite preset: Solid transforms and Weber's DOM/runtime module bindings. */
export async function weber(options = {}) {
  const project = options.project ?? process.env.WEBER_PROJECT_ROOT ?? process.cwd();
  const aot = (options.engine ?? process.env.WEBER_BUILD_ENGINE ?? 'web') === 'aot';
  if (aot && !checkout) throw new Error('Experimental AOT requires the Weber source checkout');
  const solidRoot = packageDirectory('solid-js', project);
  const aliases = [
    { find: '@weber/runtime', replacement: join(sdk, 'runtime.ts') },
    { find: '@weber/solid', replacement: join(sdk, 'solid.ts') },
    { find: '@weber/dom', replacement: aot ? join(root, 'app/src/aot-web.ts') : join(sdk, 'web.ts') },
    ...(aot ? [{ find: 'weber-aot-web', replacement: join(root, 'app/src/aot-web.ts') }] : []),
    { find: '@weber/sdk/dev', replacement: join(sdk, 'dev.ts') },
    { find: '@weber/sdk/backend', replacement: join(sdk, 'backend.ts') },
    { find: '@weber/sdk/window', replacement: join(sdk, 'window.ts') },
    { find: '@weber/sdk/storage', replacement: join(sdk, 'storage.ts') },
  ];
  // SDK modules live outside the user's project; resolve them against the same
  // Solid installation so signals, stores and the renderer share one instance.
  const bindings = {
    name: 'weber:bindings',
    enforce: 'pre',
    resolveId(id) {
      if (id.startsWith('node:') || builtinModules.includes(id)) this.error(`Node.js runtime API "${id}" is not available in Weber UI code. Use a native API or a separate backend runtime.`);
    },
    config(_, env) {
      const dev = !aot && env.command === 'serve';
      const solidAliases = [
        ['solid-js', `dist/${dev ? 'dev' : 'solid'}.js`],
        ['solid-js/web', `web/dist/${dev ? 'dev' : 'web'}.js`],
        ['solid-js/store', `store/dist/${dev ? 'dev' : 'store'}.js`],
      ].map(([name, file]) => ({ find: new RegExp(`^${name}$`), replacement: join(solidRoot, file) }));
      return { resolve: { alias: [...aliases, ...solidAliases], dedupe: ['solid-js'] }, server: { fs: { allow: [project, sdk, ...(aot ? [join(root, 'app/src')] : []), solidRoot] } } };
    },
  };
  if (options.solid === false) return bindings;
  const { default: solid } = await importTool('vite-plugin-solid', project);
  return [solid({ hot: !aot, solid: { moduleName: aot ? 'weber-aot-web' : 'solid-js/web' } }), bindings];
}
