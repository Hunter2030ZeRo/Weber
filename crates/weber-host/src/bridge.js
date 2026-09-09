(() => {
  'use strict';
  const queue = [];
  const pending = new Map();
  let next = 0;
  Object.defineProperty(globalThis, 'weber', {
    configurable: false,
    value: Object.freeze({
      invoke(channel, payload = null) {
        if (typeof channel !== 'string' || !channel || channel.length > 128) return Promise.reject(new TypeError('Invalid channel'));
        if (pending.size >= 128) return Promise.reject(new Error('Too many pending calls'));
        let safePayload;
        try {
          const encoded = JSON.stringify(payload);
          if (typeof encoded !== 'string' || encoded.length > 32768) throw new Error('Payload exceeds limit or is not JSON');
          safePayload = JSON.parse(encoded);
        } catch (error) { return Promise.reject(error); }
        const call = ++next;
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            pending.delete(call);
            const index = queue.findIndex(item => item.call === call);
            if (index >= 0) queue.splice(index, 1);
            reject(new Error('Backend invocation timed out'));
          }, 30000);
          pending.set(call, { resolve, reject, timer });
          queue.push({ call, channel, payload: safePayload });
        });
      }
    })
  });
  // Host entrypoints live in the same realm. This is NOT contextIsolation.
  Object.defineProperty(globalThis, '__weberDrain', { value: () => queue.splice(0, 8) });
  Object.defineProperty(globalThis, '__weberReply', { value: reply => {
    const item = pending.get(reply.call);
    if (!item) return;
    pending.delete(reply.call);
    clearTimeout(item.timer);
    if (typeof reply.error === 'string') item.reject(new Error(reply.error));
    else item.resolve(reply.result);
  } });
})();
