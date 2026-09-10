// Copyright Weber contributors. SPDX-License-Identifier: MIT
'use strict';

// Electron's source wrapper owns getSources coalescing and callback cleanup.
// Capture runs only on explicit requests, in the native GTK host's UI thread.
const MAX_IMAGE_BYTES = 16 * 1024 * 1024;
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
function capturedImage(value) {
  const { data, size } = value || {};
  if (typeof data !== 'string' || data.length > MAX_IMAGE_BYTES * 4 / 3 + 4 ||
      !size || !Number.isInteger(size.width) || !Number.isInteger(size.height) ||
      size.width < 0 || size.height < 0 || size.width > 1024 || size.height > 1024)
    throw new Error('Invalid native capture image');
  const png = Buffer.from(data, 'base64');
  if (data !== png.toString('base64') || (png.length === 0 && (size.width !== 0 || size.height !== 0)) ||
      (png.length > 0 && (png.length < 33 || !png.subarray(0, 8).equals(PNG) ||
        png.toString('ascii', 12, 16) !== 'IHDR' || png.readUInt32BE(16) !== size.width ||
        png.readUInt32BE(20) !== size.height || !size.width || !size.height)))
    throw new Error('Invalid native capture PNG');
  const width = size.width, height = size.height;
  function scale(value) {
    if (value !== undefined && value !== 1)
      throw Object.assign(new Error('Captured images contain only scale factor 1'), { code: 'ERR_WEBER_UNSUPPORTED' });
  }
  return Object.freeze({
    isEmpty: () => png.length === 0,
    getSize: factor => { scale(factor); return { width, height }; },
    getAspectRatio: factor => { scale(factor); return height ? width / height : 1; },
    getScaleFactors: () => png.length ? [1] : [],
    toPNG: options => { scale(options?.scaleFactor); return Buffer.from(png); },
    toDataURL: options => { scale(options?.scaleFactor); return `data:image/png;base64,${data}`; },
  });
}

function createDesktopCapturerBinding({ app, host }) {
  let closed = false;
  const active = new Set();
  function finish(capturer, error, sources) {
    if (!active.delete(capturer)) return;
    if (error) capturer._onerror?.(error.message || String(error));
    else capturer._onfinished?.(sources);
  }
  function close() {
    if (closed) return;
    closed = true;
    for (const capturer of [...active]) finish(capturer, new Error('Desktop capture runtime is closed'));
  }
  app.once('quit', close);
  host.once('closed', close);
  return {
    // X11 uses source enumeration. No system display-media picker is connected.
    isDisplayMediaSystemPickerAvailable: () => false,
    createDesktopCapturer() {
      const capturer = {
        startHandling(captureWindow, captureScreen, thumbnailSize, fetchWindowIcons) {
          // Keep every error inside the native callback contract. Throwing here
          // would leave Electron's currentlyRunning coalescing entry stranded.
          let size, snapshotError;
          try { size = { width: thumbnailSize?.width, height: thumbnailSize?.height }; }
          catch (error) { snapshotError = error; }
          Promise.resolve().then(async () => {
            if (snapshotError) throw snapshotError;
            if (closed) throw new Error('Desktop capture runtime is closed');
            if (!app.isReady()) throw new Error('desktopCapturer.getSources requires a ready app');
            if (active.size >= 8) throw new RangeError('Too many pending desktop capture requests');
            if (typeof captureWindow !== 'boolean' || typeof captureScreen !== 'boolean' ||
                typeof fetchWindowIcons !== 'boolean' || !size ||
                !Number.isInteger(size.width) || !Number.isInteger(size.height) ||
                size.width < 0 || size.height < 0 ||
                size.width > 1024 || size.height > 1024)
              throw new TypeError('Invalid desktop capture options (thumbnail dimensions must be 0..1024)');
            active.add(capturer);
            if (!captureWindow && !captureScreen) return [];
            const sources = await host.request('desktop.captureSources', {
              captureWindow, captureScreen, thumbnailSize: size, fetchWindowIcons,
            });
            if (closed || !active.has(capturer)) return;
            if (!Array.isArray(sources) || sources.length > 256) throw new Error('Invalid native capture sources');
            return sources.map(source => {
              if (!source || typeof source.id !== 'string' || !/^(window|screen):\d+:\d+$/.test(source.id) ||
                  typeof source.name !== 'string' || typeof source.display_id !== 'string')
                throw new Error('Invalid native capture source');
              return { id: source.id, name: source.name, display_id: source.display_id,
                thumbnail: capturedImage(source.thumbnail),
                appIcon: source.appIcon == null ? null : capturedImage(source.appIcon) };
            });
          }).then(sources => finish(capturer, null, sources), error => {
            if (active.has(capturer)) finish(capturer, error);
            else if (!closed) capturer._onerror?.(error.message || String(error));
            else capturer._onerror?.('Desktop capture runtime is closed');
          });
        },
      };
      return capturer;
    },
  };
}
module.exports = { createDesktopCapturerBinding, capturedImage };
