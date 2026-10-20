import { spawn } from 'node:child_process';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { metadata, withTarget, viteConfig, host } from './project.mjs';
import { buildBackend } from './backend-build.mjs';

export async function dev(project) {
  const binary = host(false, project);
  const { config: application } = await metadata(project);
  const temporary = application.backend ? await mkdtemp(join(tmpdir(), 'weber-backend-dev-')) : undefined;
  let backend;
  try { if (temporary) backend = await buildBackend(project, application, temporary); }
  catch (error) { if (temporary) await rm(temporary, { recursive: true, force: true }); throw error; }
  const capability = randomBytes(32).toString('hex');
  let server;
  try {
    const { vite, config } = await withTarget(project, 'web', () => viteConfig(project, 'serve'));
    const diagnostics = await readFile(new URL('./diagnostics.mjs', import.meta.url), 'utf8');
    server = await vite.createServer(vite.mergeConfig(config, { server: { host: '127.0.0.1', open: false }, plugins: [{ name: 'weber:native-capability', transformIndexHtml: () => [{ tag:'script',children:diagnostics,injectTo:'head-prepend' }, ...(backend ? [{ tag: 'meta', attrs: { name: 'weber-backend', content: capability }, injectTo: 'head' }] : []), { tag: 'meta', attrs: { name: 'weber-native', content: capability }, injectTo: 'head' }] }] }));
  }
  catch (error) { if (temporary) await rm(temporary, { recursive: true, force: true }); throw error; }
  let child, stopping, finished = false;
  const stop = () => stopping ??= (async () => {
    if (child && !finished) {
      const closed = new Promise(resolveClose => child.once('close', resolveClose));
      child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 3000); timer.unref();
      await closed; clearTimeout(timer);
    }
    await server.close();
    if (temporary) await rm(temporary, { recursive: true, force: true });
  })();
  const interrupted = () => { void stop(); };
  process.once('SIGINT', interrupted); process.once('SIGTERM', interrupted);
  try {
    await server.listen(); server.printUrls();
    if (stopping) return;
    const address = server.httpServer?.address();
    if (!address || typeof address === 'string') throw new Error('Weber development requires a TCP Vite server');
    const url = `${server.config.server.https ? 'https' : 'http'}://127.0.0.1:${address.port}${server.config.base}`;
    console.log(`Weber development (SpiderMonkey): ${url}`);
    const env = { ...process.env, WEBER_NATIVE_CAPABILITY: capability };
    delete env.WEBER_BACKEND_EXECUTABLE; delete env.WEBER_BACKEND_SHA256; delete env.WEBER_BACKEND_CAPABILITY;
    if (backend) { env.WEBER_BACKEND_EXECUTABLE = join(temporary, backend.file); env.WEBER_BACKEND_SHA256 = backend.sha256; env.WEBER_BACKEND_CAPABILITY = capability; }
    child = spawn(binary, [url], { cwd: project, env: { ...env, WEBER_APP_ID: application.id }, stdio: 'inherit' });
    const result = await new Promise((resolveExit, reject) => { child.once('error', error => { finished = true; reject(error); }); child.once('close', (code, signal) => { finished = true; resolveExit({ code, signal }); }); });
    if (!stopping && (result.code !== 0 || result.signal)) throw new Error(`Weber host exited ${result.code ?? result.signal}`);
  } finally { await stop(); process.removeListener('SIGINT', interrupted); process.removeListener('SIGTERM', interrupted); }
}
