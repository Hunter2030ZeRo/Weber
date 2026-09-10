// Copyright Weber contributors. SPDX-License-Identifier: MIT
'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { performance, PerformanceObserver } = require('node:perf_hooks');

function createDiagnosticsBinding({ unsupported }) {
  const parameters = new Map();
  // An inactive reporter has no uploaded reports. Enabling collection must
  // fail until a native crash collector exists; never pretend it was started.
  const crashReporter = {
    start() { return unsupported('crashReporter.start: native crash collection'); },
    getUploadedReports: () => [],
    getUploadToServer: () => false,
    setUploadToServer(value) {
      if (typeof value !== 'boolean') throw new TypeError('uploadToServer must be boolean');
      if (value) return unsupported('crashReporter upload: native crash collection');
    },
    addExtraParameter(key, value) {
      if (typeof key !== 'string' || typeof value !== 'string') throw new TypeError('Crash parameters must be strings');
      if (!key || Buffer.byteLength(key) > 39 || Buffer.byteLength(value) > 20 * 1024 ||
          (!parameters.has(key) && parameters.size >= 128)) throw new RangeError('Crash parameter limit exceeded');
      parameters.set(key, value);
    },
    removeExtraParameter(key) { parameters.delete(key); },
    getParameters: () => Object.fromEntries(parameters),
  };

  const category = 'weber.main.user_timing';
  const maxEvents = 4096, maxBytes = 4 * 1024 * 1024;
  let active;
  const tracing = {
    getCategories: async () => process.versions.bun ? [] : [category],
    async startRecording(config = {}) {
      if (process.versions.bun) return unsupported('contentTracing on Bun');
      if (active) throw new Error('Tracing is already active');
      if (!config || typeof config !== 'object' || Array.isArray(config)) throw new TypeError('Invalid trace configuration');
      const allowed = new Set(['included_categories', 'excluded_categories', 'recording_mode']);
      if (Object.keys(config).some(key => !allowed.has(key))) return unsupported('contentTracing configuration');
      for (const key of ['included_categories', 'excluded_categories']) {
        if (config[key] !== undefined && (!Array.isArray(config[key]) || config[key].some(value => typeof value !== 'string')))
          throw new TypeError('Trace categories must be string arrays');
      }
      if (config.included_categories?.some(value => value !== category && value !== '*') || config.excluded_categories?.length)
        return unsupported('contentTracing categories outside the main user-timing stream');
      if (config.recording_mode && config.recording_mode !== 'record-until-full') return unsupported('contentTracing recording mode');
      // Configuration accessors can re-enter startRecording synchronously.
      // Recheck after all application-owned property reads, before ownership.
      if (active) throw new Error('Tracing is already active');
      const state = { events: [], bytes: 0, dropped: 0, observer: null, stopping: false };
      const receive = entries => {
        for (const entry of entries) {
          const item = { cat: category, name: entry.name, pid: process.pid, tid: 0,
            ts: Math.round(entry.startTime * 1000),
            ...(entry.entryType === 'measure' ? { ph: 'X', dur: Math.round(entry.duration * 1000) } : { ph: 'i', s: 't' }) };
          const bytes = Buffer.byteLength(JSON.stringify(item));
          if (state.events.length >= maxEvents || state.bytes + bytes > maxBytes) { state.dropped++; continue; }
          state.events.push(item); state.bytes += bytes;
        }
      };
      state.receive = receive;
      state.observer = new PerformanceObserver(list => receive(list.getEntries()));
      state.observer.observe({ entryTypes: ['mark', 'measure'] });
      active = state;
    },
    async getTraceBufferUsage() {
      return { percentFull: active ? Math.max(active.events.length / maxEvents, active.bytes / maxBytes) : 0,
        approximateEventCount: active?.events.length || 0 };
    },
    async stopRecording(output) {
      if (!active || active.stopping) throw new Error('Tracing is not active');
      if (output !== undefined && (typeof output !== 'string' || !path.isAbsolute(output))) throw new TypeError('Trace output must be an absolute path');
      const state = active; state.stopping = true;
      state.receive(state.observer.takeRecords()); state.observer.disconnect();
      try {
        if (!output) output = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'weber-trace-')), 'trace.json');
        await fs.writeFile(output, JSON.stringify({ traceEvents: [
          { ph: 'M', name: 'process_name', pid: process.pid, tid: 0, args: { name: 'Weber main' } }, ...state.events
        ], metadata: { source: category, timeOrigin: performance.timeOrigin, droppedEvents: state.dropped,
          includesRenderers: false } }), { mode: 0o600 });
        return output;
      } finally { active = undefined; }
    },
  };
  return { crashReporter, tracing };
}
module.exports = { createDiagnosticsBinding };
