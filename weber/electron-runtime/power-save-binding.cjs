// Copyright Weber contributors. SPDX-License-Identifier: MIT
'use strict';
function createPowerSaveBinding({ host, app }) {
  let requests = new Map(), nextId = 0, generation = 0, active = 'none', closed = false, busy = false, pendingLoss;
  const effective = values => {
    let mode = 'none';
    for (const value of values.values()) {
      if (value === 'prevent-display-sleep') return value;
      mode = 'prevent-app-suspension';
    }
    return mode;
  };
  function lost(event) {
    if (closed || event.generation !== generation || active === 'none') return;
    requests.clear(); active = 'none';
    const error = Object.assign(new Error('Operating system power-save inhibitor was lost'), { code: 'ERR_WEBER_INHIBITOR_LOST' });
    // This is recoverable OS state loss, not the fatal host-error channel.
    if (!app.emit('weber-power-save-blocker-lost', error)) process.emitWarning(error);
  }
  host.on('event', event => {
    if (event.event !== 'power-save-blocker-lost') return;
    if (busy) pendingLoss = event; else lost(event);
  });
  host.once('closed', () => { closed = true; requests.clear(); active = 'none'; });
  function update(next) {
    if (closed) throw new Error('Power-save blocker host is closed');
    if (busy) throw new Error('Re-entrant power-save blocker mutation');
    busy = true;
    try {
      const mode = effective(next);
      if (mode !== active) {
        const response = host.requestSync('powerSaveBlocker.set', { mode, application: app.getName() });
        if (closed) throw new Error('Power-save blocker host closed during mutation');
        generation = response.generation;
        active = mode;
      }
      requests = next;
    } finally {
      busy = false;
      if (pendingLoss) { const event = pendingLoss; pendingLoss = undefined; lost(event); }
    }
  }
  const validId = id => {
    if (!Number.isInteger(id) || id < -2147483648 || id > 2147483647) throw new TypeError('Invalid power-save blocker id');
  };
  app.once('quit', () => {
    try { if (!closed && active !== 'none') host.requestSync('powerSaveBlocker.set', { mode: 'none' }); }
    catch (error) { app.emit('weber-error', error); }
    finally { closed = true; requests.clear(); active = 'none'; }
  });
  return {
    start(type) {
      if (type !== 'prevent-app-suspension' && type !== 'prevent-display-sleep') throw new TypeError('Invalid power-save blocker type');
      if (requests.size >= 128 || nextId > 2147483647) throw new RangeError('Power-save blocker limit exceeded');
      const id = nextId;
      const next = new Map(requests); next.set(id, type); update(next);
      nextId++;
      return id;
    },
    stop(id) {
      validId(id);
      if (!requests.has(id)) return false;
      const next = new Map(requests); next.delete(id); update(next); return true;
    },
    isStarted(id) { validId(id); return requests.has(id); },
  };
}
module.exports = { createPowerSaveBinding };
