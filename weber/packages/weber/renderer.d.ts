import type { Json } from './index.d.ts';
declare global {
  interface Window { weber: { invoke(channel: string, payload?: Json): Promise<Json> } }
}
export {};
