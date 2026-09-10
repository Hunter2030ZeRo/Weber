// Copyright Weber contributors. SPDX-License-Identifier: MIT
'use strict';
const LIMIT = 2 * 1024 * 1024;
const type = value => {
  if (typeof value !== 'string' || !value.length || Buffer.byteLength(value) > 256 || value.includes('\0'))
    throw new TypeError('Invalid clipboard format');
  return value;
};
class NativeClipboardItem {
  constructor(items) {
    if (!items || typeof items !== 'object' || Array.isArray(items) || !Object.keys(items).length)
      throw new TypeError('ClipboardItem requires MIME payloads');
    this.data = new Map();
    let total = 0;
    for (const [format, value] of Object.entries(items)) {
      type(format);
      if (!Buffer.isBuffer(value) && typeof value !== 'string') throw new TypeError('Clipboard payload must be a Buffer or string');
      const bytes = Buffer.from(value);
      total += bytes.length;
      if (total > LIMIT || this.data.size >= 64) throw new RangeError('Clipboard exceeds 2 MiB or 64 formats');
      this.data.set(format, bytes);
    }
  }
  get types() { return [...this.data.keys()]; }
  async getType(format) {
    const bytes = this.data.get(format);
    if (!bytes) throw new Error(`The type '${format}' was not found in the ClipboardItem`);
    return Buffer.from(bytes);
  }
}
function createClipboardBinding({ host, app }) {
  const call = (selection, method, fields = {}) => {
    if (!app.isReady()) throw new Error('clipboard cannot be used before app is ready');
    return host.requestSync(`clipboard.${method}`, { selection, ...fields });
  };
  const apiFor = selection => {
    const formats = () => call(selection, 'formats');
    const readBuffer = format => Buffer.from(call(selection, 'read', { format: type(format) }) || '', 'base64');
    const writeBuffers = data => {
      const payloads = new Map(data);
      // Native X11 text consumers request these target atoms instead of MIME.
      if (payloads.has('text/plain')) {
        payloads.set('UTF8_STRING', payloads.get('text/plain'));
        payloads.set('text/plain;charset=utf-8', payloads.get('text/plain'));
      }
      let total = 0;
      const items = [...payloads].map(([format, value]) => {
        type(format);
        if (!Buffer.isBuffer(value)) throw new TypeError('Clipboard payload must be a Buffer');
        total += value.length;
        return { format, data: value.toString('base64') };
      });
      if (items.length > 64 || total > LIMIT) throw new RangeError('Clipboard exceeds 2 MiB or 64 formats');
      if (!items.length) { call(selection, 'clear'); return; }
      call(selection, 'write', { items });
    };
    const api = {
      clear() { call(selection, 'clear'); },
      has(format) { return formats().includes(type(format)); },
      readText() {
        const available = formats();
        const format = ['UTF8_STRING', 'text/plain;charset=utf-8', 'text/plain'].find(value => available.includes(value));
        return format ? readBuffer(format).toString('utf8') : '';
      },
      writeText(value) {
        if (typeof value !== 'string') throw new TypeError('Clipboard text must be a string');
        writeBuffers(new Map([['text/plain', Buffer.from(value)]]));
      },
      read() {
        const entries = formats().filter(value => value.includes('/'));
        if (!entries.length) return [];
        const snapshot = Object.fromEntries(entries.map(format => [format, readBuffer(format)]));
        return [new NativeClipboardItem(snapshot)];
      },
      write(items) {
        if (!Array.isArray(items) || items.length > 1 || items.some(item => !(item instanceof NativeClipboardItem)))
          throw new TypeError('Linux clipboard accepts at most one ClipboardItem');
        writeBuffers(items[0]?.data || new Map());
      },
      availableFormats: formats, readBuffer,
      writeBuffer(format, bytes) { writeBuffers(new Map([[type(format), bytes]])); },
      writeLegacy(data) {
        if (!data || typeof data !== 'object') throw new TypeError('Clipboard data must be an object');
        const entries = new Map();
        for (const [key, format] of [['text', 'text/plain'], ['html', 'text/html'], ['rtf', 'text/rtf']]) {
          if (data[key] !== undefined) {
            if (typeof data[key] !== 'string') throw new TypeError(`Clipboard ${key} must be a string`);
            entries.set(format, Buffer.from(data[key]));
          }
        }
        if (data.image !== undefined) {
          if (typeof data.image?.toPNG !== 'function') throw new TypeError('Clipboard image must be a NativeImage');
          entries.set('image/png', data.image.toPNG());
        }
        if (data.bookmark !== undefined) throw new Error('Weber has not implemented clipboard bookmarks');
        writeBuffers(entries);
      },
    };
    return api;
  };
  const clipboard = apiFor('clipboard');
  clipboard.selection = apiFor('selection');
  const select = which => {
    if (which === undefined || which === 'clipboard') return clipboard;
    if (which === 'selection') return clipboard.selection;
    throw new TypeError('Invalid clipboard selection');
  };
  return { clipboard, NativeClipboardItem, decorate(api) {
    const modernWrite = api.write;
    api.write = (items, which) => Array.isArray(items) ? modernWrite(items) : select(which).writeLegacy(items);
    for (const name of ['readText', 'clear', 'availableFormats']) api[name] = which => select(which)[name]();
    api.writeText = (text, which) => select(which).writeText(text);
    api.readBuffer = (format, which) => select(which).readBuffer(format);
    api.writeBuffer = (format, bytes, which) => select(which).writeBuffer(format, bytes);
    api.has = api.isFormatAvailable = (format, which) => select(which).has(format);
    for (const [name, format] of [['HTML', 'text/html'], ['RTF', 'text/rtf']]) {
      api[`read${name}`] = which => select(which).readBuffer(format).toString('utf8');
      api[`write${name}`] = (value, which) => {
        if (typeof value !== 'string') throw new TypeError('Clipboard text must be a string');
        select(which).writeBuffer(format, Buffer.from(value));
      };
    }
    api.writeImage = (image, which) => select(which).writeLegacy({ image });
    api.readImage = which => {
      const png = select(which).readBuffer('image/png');
      return { isEmpty: () => png.length === 0, toPNG: () => Buffer.from(png) };
    };
    return api;
  } };
}
module.exports = { createClipboardBinding };
