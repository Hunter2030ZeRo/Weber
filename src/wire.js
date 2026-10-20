// Weber wire v1: bounded tagged values, binary64 numbers and UTF-16 code units.
// Strings never pass through JSON, UTF-8 conversion or decimal number formatting.
globalThis.WeberWire = (() => {
  const LIMIT = 1048576, DEPTH = 64;
  function encode(value) {
    let size = 4;
    const ancestors = new Set();
    function visit(value, depth, write) {
      if (depth > DEPTH) throw new RangeError("Wire nesting limit");
      if (value === null || value === undefined) { write(0); return; }
      if (typeof value === "boolean") { write(value ? 2 : 1); return; }
      if (typeof value === "number") { if (!Number.isFinite(value)) throw new TypeError("Nonfinite wire number"); write(3, value); return; }
      if (typeof value === "string") { write(4, value); return; }
      if (typeof value !== "object" || ancestors.has(value)) throw new TypeError("Invalid wire value");
      ancestors.add(value);
      if (Array.isArray(value)) { write(5, value.length); for (const entry of value) visit(entry, depth + 1, write); }
      else {
        const keys = Object.keys(value).filter(key => value[key] !== undefined);
        write(6, keys.length);
        for (const key of keys) { visit(key, depth + 1, write); visit(value[key], depth + 1, write); }
      }
      ancestors.delete(value);
    }
    visit(value, 0, (tag, value) => { size += 1 + (tag === 3 ? 8 : tag === 4 ? 4 + value.length * 2 : tag >= 5 ? 4 : 0); if (size > LIMIT) throw new RangeError("Wire size limit"); });
    const buffer = new ArrayBuffer(size), bytes = new Uint8Array(buffer), view = new DataView(buffer);
    bytes.set([87, 66, 82, 1]); let offset = 4;
    visit(value, 0, (tag, value) => {
      if (offset >= size) throw new TypeError("Wire value changed during encoding");
      view.setUint8(offset++, tag);
      if (tag === 3) { view.setFloat64(offset, value, true); offset += 8; }
      else if (tag >= 4) {
        view.setUint32(offset, tag === 4 ? value.length : value, true); offset += 4;
        if (tag === 4) for (let index = 0; index < value.length; index++) { view.setUint16(offset, value.charCodeAt(index), true); offset += 2; }
      }
    });
    if (offset !== size) throw new TypeError("Wire value changed during encoding");
    return bytes;
  }
  function decode(bytes) {
    if (!(bytes instanceof Uint8Array) || bytes.byteLength < 5 || bytes.byteLength > LIMIT) throw new TypeError("Invalid wire buffer");
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); let offset = 4;
    if (view.getUint32(0, true) !== 0x01524257) throw new TypeError("Unknown wire version");
    const need = length => { if (length > bytes.byteLength - offset) throw new TypeError("Truncated wire value"); };
    function read(depth) {
      if (depth > DEPTH) throw new RangeError("Wire nesting limit");
      need(1); const tag = view.getUint8(offset++);
      if (tag === 0) return null; if (tag === 1) return false; if (tag === 2) return true;
      if (tag === 3) { need(8); const value = view.getFloat64(offset, true); offset += 8; if (!Number.isFinite(value)) throw new TypeError("Nonfinite wire number"); return value; }
      if (tag < 4 || tag > 6) throw new TypeError("Unknown wire tag");
      need(4); const count = view.getUint32(offset, true); offset += 4;
      if (tag === 4) {
        need(count * 2); let value = "";
        for (let index = 0; index < count; index++) { value += String.fromCharCode(view.getUint16(offset, true)); offset += 2; }
        return value;
      }
      need(count * (tag === 6 ? 2 : 1));
      if (tag === 5) { const value = []; for (let index = 0; index < count; index++) value.push(read(depth + 1)); return value; }
      const value = {};
      for (let index = 0; index < count; index++) {
        const key = read(depth + 1);
        if (typeof key !== "string" || Object.prototype.hasOwnProperty.call(value, key)) throw new TypeError("Invalid wire key");
        Object.defineProperty(value, key, { value: read(depth + 1), enumerable: true, configurable: true, writable: true });
      }
      return value;
    }
    const result = read(0); if (offset !== bytes.byteLength) throw new TypeError("Trailing wire data"); return result;
  }
  return { encode, decode, version: 1 };
})();
