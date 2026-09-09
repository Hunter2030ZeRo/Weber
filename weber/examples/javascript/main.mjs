import { app, BrowserWindow, ipcMain } from '../../packages/weber/index.mjs';
import { fileURLToPath } from 'node:url';

ipcMain.handle('system.info', () => ({
  backend: process.versions.bun ? `Bun ${process.versions.bun}` : `Node.js ${process.versions.node}`,
  platform: process.platform
}));
app.on('window-all-closed', () => { void app.quit().catch(console.error); });
try {
  await app.whenReady();
  const channels = process.env.WEBER_ALLOWED_CHANNELS ? JSON.parse(process.env.WEBER_ALLOWED_CHANNELS) : ['system.info'];
  const window = new BrowserWindow({ title: 'Weber / Obscura', allowedChannels: channels });
  await window.loadFile(process.env.WEBER_FRONTEND ?? fileURLToPath(new URL('./index.html', import.meta.url)));
} catch (error) {
  console.error(error);
  app.dispose();
  process.exitCode = 1;
}
