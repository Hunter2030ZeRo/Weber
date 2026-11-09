import { answer } from './module-value.mjs';
self.onmessage = () => self.postMessage(answer);
