// Copyright Weber contributors. SPDX-License-Identifier: MIT
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { Socket } = require('./utility-socket.cjs');
const { spawn } = require('node:child_process');
const { constants } = require('node:os');
const { UtilityWire } = require('./utility-wire.cjs');
const { prepareRemoteTransfer } = require('./message-port-binding.cjs');

function createUtilityBinding({ app, unsupported, native = require('./dist/native/weber_platform.node') }) {
  const active = new Set();
  const stopAll = () => { for (const handle of active) handle.stop('SIGKILL'); };
  app.on('quit', stopAll);
  process.once('exit', stopAll);
  function _fork({ modulePath, args = [], options = {} }) {
    if (!app.isReady()) throw new Error('utilityProcess.fork is only available after app is ready');
    if (active.size >= 32) throw new RangeError('At most 32 utility processes may be active');
    if (typeof modulePath !== 'string' || !modulePath || modulePath.includes('\0')) throw new TypeError('Invalid utility entry path');
    if (!Array.isArray(args) || args.some(value => typeof value !== 'string')) throw new TypeError('Utility args must be strings');
    if (options.execArgv && (!Array.isArray(options.execArgv) || options.execArgv.some(value => typeof value !== 'string')))
      throw new TypeError('Utility execArgv must be strings');
    if (options.env !== undefined && (!options.env || typeof options.env !== 'object' || Array.isArray(options.env))) throw new TypeError('Invalid utility environment');
    for (const name of ['allowLoadingUnsignedLibraries', 'respondToAuthRequests'])
      if (options[name]) unsupported('utilityProcess option ' + name);
    const entry = path.resolve(modulePath);
    const cwd = options.cwd === undefined ? process.cwd() : path.resolve(options.cwd);
    const stdio = options.stdio || ['ignore', 'inherit', 'inherit'];
    if (!Array.isArray(stdio) || stdio.length !== 3 || stdio[0] !== 'ignore' || stdio.slice(1).some(value => !['inherit', 'ignore', 'pipe'].includes(value)))
      throw new TypeError('Invalid utility stdio configuration');
    const pipes = [];
    let child, wire;
    const ports = new Map();
    let nextPort = 0, exited = false, exitEmitted = false;
    const handle = { emit() {}, pid: undefined,
      stop(signal) { if (!exited && child) return child.kill(signal); return false; },
      kill() { return handle.stop('SIGTERM'); },
      postMessage(data, transfer = []) {
        if (exited) return;
        // Serialization can invoke application getters. Finish that work before
        // observing port ownership or allocating IDs; re-entrant sends/close
        // must not invalidate a previously captured transfer plan.
        const copied = structuredClone(data);
        const commit = prepareRemoteTransfer(transfer);
        if (ports.size + transfer.length > 64 || nextPort + transfer.length > Number.MAX_SAFE_INTEGER)
          throw new RangeError('Utility process exceeds its transferred port limit');
        const ids = transfer.map((_, n) => nextPort + n + 1);
        // Serialize and reserve before detaching any source endpoint.
        const frame = wire.prepare({ kind: 'deliver', data: copied, ports: ids }, true);
        const owners = commit((index, name, event) => {
          const id = ids[index];
          if (name === 'close') ports.delete(id);
          if (wire.closed) return;
          try {
            if (name === 'message') wire.send({ kind: 'port-message', id, data: event.data });
            else if (name === 'close') wire.send({ kind: 'port-close', id });
          } catch (error) { failure(error); }
        });
        owners.forEach((owner, n) => ports.set(ids[n], owner));
        nextPort += ids.length;
        wire.sendPrepared(frame);
      },
    };
    function failure(error) {
      if (exited) return;
      handle.stop('SIGKILL');
      app.emit('weber-error', error);
    }
    function finish(code, signal) {
      if (exitEmitted) return;
      exitEmitted = true; exited = true;
      active.delete(handle);
      wire?.close();
      for (const port of ports.values()) port.close();
      ports.clear();
      // Close descriptors not yet handed to the original Electron wrapper.
      for (const pipe of pipes) native.close(pipe.channel);
      const exitCode = code ?? (signal ? 128 + (constants.signals[signal] || 0) : 1);
      try { handle.emit('exit', exitCode); }
      finally { handle.pid = undefined; }
      if (signal || exitCode !== 0) app.emit('child-process-gone', {}, {
        type: 'Utility', reason: signal ? (signal === 'SIGTERM' || signal === 'SIGKILL' ? 'killed' : 'crashed') : 'abnormal-exit',
        exitCode, serviceName: options.serviceName || 'Node Utility Process', name: path.basename(entry),
      });
    }
    try {
      const transport = native.create();
      pipes.push({ channel: transport });
      const descriptors = ['ignore'];
      for (const name of ['stdout', 'stderr']) {
        const value = stdio[descriptors.length];
        if (value === 'pipe') {
          const channel = native.create(); pipes.push({ name, channel });
          descriptors.push(native.childFd(channel));
        } else descriptors.push(value);
      }
      descriptors.push(native.childFd(transport));
      const environment = { ...(options.env || process.env), WEBER_UTILITY_PARENT_PID: String(process.pid) };
      // Do not inherit the main app selector into the utility entry.
      delete environment.WEBER_ENTRY;
      child = spawn(process.execPath, [...(options.execArgv || []), path.join(__dirname, 'utility-bootstrap.cjs'), entry, ...args],
        { cwd, env: environment, stdio: descriptors, shell: false });
      handle.pid = child.pid;
      for (const pipe of pipes) native.releaseChild(pipe.channel);
      wire = new UtilityWire(new Socket({ fd: native.takeParent(transport), readable: true, writable: true }));
      wire.on('failure', failure);
      wire.on('message', message => {
        if (!message || typeof message !== 'object') throw new Error('Invalid utility message');
        if (message.kind === 'message') handle.emit('message', message.data);
        else if (message.kind === 'port-message') {
          const port = ports.get(message.id);
          if (port) port.postMessage(message.data);
          else if (!Number.isSafeInteger(message.id) || message.id < 1 || message.id > nextPort) throw new Error('Unknown utility port');
        } else if (message.kind === 'port-close') {
          const port = ports.get(message.id); ports.delete(message.id); port?.close();
        } else if (message.kind !== 'ready') throw new Error('Unknown utility message kind');
      });
      child.once('spawn', () => {
        for (const pipe of pipes) if (pipe.name) {
          const fd = native.takeParent(pipe.channel);
          try { handle.emit(pipe.name, fd); } catch (error) { fs.closeSync(fd); throw error; }
        }
        handle.emit('spawn');
      });
      child.once('error', error => { finish(1, null); app.emit('weber-error', error); });
      child.once('exit', (code, signal) => {
        exited = true;
        if (wire.closed) return finish(code, signal);
        // SIGCHLD may be observed before the private socket's last readable
        // event. Drain to EOF before reporting exit; inherited descriptors must
        // not hold the parent indefinitely after the owned child has exited.
        const deadline = setTimeout(() => finish(code, signal), 250);
        wire.once('closed', () => { clearTimeout(deadline); finish(code, signal); });
        wire.read();
      });
      active.add(handle);
      return handle;
    } catch (error) {
      child?.kill('SIGKILL'); wire?.close();
      for (const pipe of pipes) native.close(pipe.channel);
      throw error;
    }
  }
  return { _fork };
}
module.exports = { createUtilityBinding };
