import { setTimeout as delay } from 'node:timers/promises';
export default {
  async clock(_, { signal, emit }) {
    while (!signal.aborted) {
      await emit({ time: new Date().toISOString() });
      try { await delay(1000, null, { signal }); } catch (error) { if (!signal.aborted) throw error; }
    }
  }
};
