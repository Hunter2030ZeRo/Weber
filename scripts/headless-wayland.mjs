// Invoke under dbus-run-session to isolate the compositor from the user's bus.
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, access, rm, readFile, writeFile, readdir } from 'node:fs/promises';
import { openSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

if (!process.argv[2]) throw new Error('Pass a test script and optional arguments');
if (process.env.DBUS_SESSION_BUS_ADDRESS?.includes('/run/user/')) throw new Error('Use dbus-run-session, not the desktop session bus');
const temp = await mkdtemp(join(tmpdir(), 'weber-wayland-'));
const runtime = join(temp, 'runtime'); await mkdir(runtime, { mode: 0o700 });
const env = { ...process.env, GDK_BACKEND: 'wayland', GSK_RENDERER: 'cairo', GTK_IM_MODULE: 'gtk-im-context-simple', GTK_A11Y: 'none', NO_AT_BRIDGE: '1', GIO_USE_VFS: 'local', GIO_USE_VOLUME_MONITOR: 'unix', XDG_RUNTIME_DIR: runtime, WAYLAND_DISPLAY: 'weber-test', XDG_CURRENT_DESKTOP: 'GNOME',
  XDG_CONFIG_HOME: join(temp, 'config'), XDG_CACHE_HOME: join(temp, 'cache'), XDG_DATA_HOME: join(temp, 'data'), XDG_STATE_HOME: join(temp, 'state'), WEBER_TEST_DISPLAY: 'isolated GNOME headless Wayland; 960x720@60 virtual monitor' };
for (const key of ['DISPLAY', 'XDG_ACTIVATION_TOKEN', 'DESKTOP_STARTUP_ID']) delete env[key];
if (env.WEBER_TEST_FILE_CHOOSER === 'gtk') {
  const directory=join(env.XDG_CONFIG_HOME,'xdg-desktop-portal');await mkdir(directory,{recursive:true});
  await writeFile(join(directory,'gnome-portals.conf'),'[preferred]\ndefault=gnome;gtk;\norg.freedesktop.impl.portal.FileChooser=gtk\n');
}
await promisify(execFile)('dbus-update-activation-environment', [
  ...['GDK_BACKEND', 'GSK_RENDERER', 'GTK_IM_MODULE', 'GTK_A11Y', 'NO_AT_BRIDGE', 'GIO_USE_VFS', 'GIO_USE_VOLUME_MONITOR', 'XDG_RUNTIME_DIR', 'WAYLAND_DISPLAY', 'XDG_CURRENT_DESKTOP', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME'].map(key => `${key}=${env[key]}`),
  'DISPLAY=', 'XDG_ACTIVATION_TOKEN=', 'DESKTOP_STARTUP_ID=',
], { env });
// A fresh profile otherwise opens Welcome over our windows and steals focus.
// This dconf write belongs only to this temporary profile and private bus.
const version = (await promisify(execFile)('gnome-shell', ['--version'], { env })).stdout.trim().split(' ').at(-1);
await promisify(execFile)('gsettings', ['set', 'org.gnome.shell', 'welcome-dialog-last-shown-version', version], { env });
const log = openSync(resolve('artifacts/headless-wayland.log'), 'w');
const compositor = spawn('gnome-shell', ['--headless', '--wayland', '--no-x11', '--wayland-display=weber-test', '--virtual-monitor=960x720@60'], { env, stdio: ['ignore', log, log] }); closeSync(log);
const exit = new Promise(resolveExit => compositor.once('exit', (code, signal) => resolveExit({ code, signal })));
try {
  let ready = false;
  for (let attempt = 0; attempt < 200; attempt++) {
    if (compositor.exitCode !== null) throw new Error('Test compositor exited; see artifacts/headless-wayland.log');
    try { await access(join(runtime, 'weber-test')); ready = true; break; } catch {}
    await delay(50);
  }
  if (!ready) throw new Error('Test Wayland display did not start');
  await delay(1500);
  const child = spawn(process.execPath, process.argv.slice(2), { env, stdio: 'inherit' });
  const code = await new Promise((resolveExit, reject) => { child.once('error', reject); child.once('exit', resolveExit); });
  if (code !== 0) process.exitCode = code ?? 1;
} finally {
  if (compositor.exitCode === null) compositor.kill();
  // A private compositor can hang while disposing portal/GPU resources after
  // the app has already exited. Bound teardown of this exact spawned process.
  const killTimer = setTimeout(() => {
    if (compositor.exitCode === null && compositor.signalCode === null) compositor.kill('SIGKILL');
  }, 3000);
  try { await exit; } finally { clearTimeout(killTimer); }
  // Activated desktop helpers can daemonize and keep test pipes open. Reap only
  // processes whose environment names this exact newly created private runtime.
  const owned=async pid=>{try{return (await readFile(`/proc/${pid}/environ`,'utf8')).split('\0').includes(`XDG_RUNTIME_DIR=${runtime}`);}catch{return false;}};
  const children=[];for(const name of await readdir('/proc')){if(/^\d+$/.test(name)&&Number(name)!==process.pid&&await owned(name))children.push(Number(name));}
  for(const pid of children){try{process.kill(pid,'SIGTERM');}catch{}}
  await delay(100);
  for(const pid of children){if(await owned(pid)){try{process.kill(pid,'SIGKILL');}catch{}}}
  // Private desktop services can mount document-portal/GVfs FUSE filesystems.
  // Discover and detach only mounts beneath our newly created test runtime.
  const mounts = (await readFile('/proc/self/mountinfo', 'utf8')).split('\n').filter(Boolean).flatMap(line => {
    const [fields, filesystem] = line.split(' - ');
    const path = fields.split(' ')[4].replace(/\\([0-7]{3})/g, (_, value) => String.fromCharCode(parseInt(value, 8)));
    return filesystem.startsWith('fuse') && path.startsWith(runtime + '/') ? [path] : [];
  }).sort((a, b) => b.length - a.length);
  for (const mount of mounts) await promisify(execFile)('fusermount3', ['-uz', mount], { env });
  await rm(temp, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
