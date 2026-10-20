// Bundled require() calls become synchronous native module initializers. No
// Node runtime is involved. Standalone tests can use the local CSS fallback;
// native applications use Servo's CSSOM without initializing this parser.
const loaded = { selectors: false, html: false, cssFallback: false };
globalThis.WeberPlatform = {
  get selectors() { loaded.selectors = true; return require("css-select"); },
  get html() { loaded.html = true; return require("parse5"); },
  get loaded() { return { ...loaded }; },
  createStyle(callback) {
    loaded.cssFallback = true;
    const { CSSStyleDeclaration } = require("cssstyle");
    if (typeof CSSStyleDeclaration !== "function") throw new Error("CSSStyleDeclaration export missing");
    return new CSSStyleDeclaration(callback);
  },
};
