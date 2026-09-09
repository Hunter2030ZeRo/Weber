import type { Json } from './index.js';
declare global {
  interface Window { weber: { invoke(channel: string, payload?: Json): Promise<Json> } }
}
export {};
