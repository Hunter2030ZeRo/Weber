import { increment } from './dependency.mjs';
globalThis.moduleLoaded = increment(classicLoaded);
document.getElementById('answer').textContent = String(moduleLoaded);
