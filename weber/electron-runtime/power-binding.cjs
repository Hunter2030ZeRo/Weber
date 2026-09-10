// Copyright Weber contributors. SPDX-License-Identifier: MIT
'use strict';
const { EventEmitter } = require('node:events');
function createPowerBinding({ host, app, unsupported }) {
  const source = new EventEmitter();
  let started = false;
  const start = () => {
    if (started) return;
    started = true;
    host.requestSync('powerMonitor.start');
  };
  host.on('event', event => {
    if (event.event === 'power-monitor') source.emit(event.type, {});
  });
  source.setListeningForShutdown = listening => {
    if (listening) return unsupported('powerMonitor shutdown inhibition');
  };
  return {
    createPowerMonitor: () => {
      if (app.isReady()) start();
      else app.whenReady().then(start).catch(error => app.emit('weber-error', error));
      return source;
    },
    getSystemIdleTime: () => host.requestSync('powerMonitor.idleTime'),
    getSystemIdleState: threshold => {
      if (!Number.isInteger(threshold) || threshold < 1 || threshold > 2147483647)
        throw new TypeError('Invalid idle threshold, must be a positive integer');
      return host.requestSync('powerMonitor.idleState', { threshold });
    },
    isOnBatteryPower: () => host.requestSync('powerMonitor.battery'),
    // Linux has no equivalent of the macOS thermal-pressure state exposed by
    // this Electron API. Its documented unknown value represents that absence.
    getCurrentThermalState: () => 'unknown',
  };
}
module.exports = { createPowerBinding };
