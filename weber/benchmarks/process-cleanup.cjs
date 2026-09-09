'use strict';
const fs = require('node:fs');
const { performance } = require('node:perf_hooks');
const { readStat } = require('./proc-tree.cjs');
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const alive = process => !['Z', 'X'].includes(process.state);

function processGroup(groupId) {
  const members = [];
  for (const name of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const process = readStat(Number(name));
      if (process.processGroupId === groupId) members.push(process);
    } catch (error) {
      if (!['ENOENT', 'ESRCH', 'EACCES'].includes(error.code)) throw error;
    }
  }
  return members;
}

function trackChild(child) {
  const known = new Map();
  let reaped = false;
  let spawnFailed = false;
  let initialError;
  child.once('spawn', () => {
    try {
      if (!Number.isInteger(child.pid) || child.pid <= 1) throw new Error('Invalid detached child PID');
      const root = readStat(child.pid);
      if (root.processGroupId !== child.pid || root.sessionId !== child.pid) {
        throw new Error('Benchmark child did not enter its own process group and session');
      }
      known.set(root.pid, root);
    } catch (error) { initialError = error; }
  });
  child.once('exit', () => { reaped = true; });
  child.once('error', () => { spawnFailed = true; reaped = true; });

  function observe(sample) {
    for (const process of sample.processes) known.set(process.pid, process);
  }
  function inspect() {
    const group = processGroup(child.pid);
    // A matching startTicks proves at least one member is from this launch,
    // even after the original process exits. A reused numeric PGID alone does
    // not authorize sending a signal.
    const verified = group.some(member => known.get(member.pid)?.startTicks === member.startTicks);
    if (group.length && !verified) throw new Error('Cannot verify ownership of remaining benchmark process group');
    if (verified) for (const member of group) known.set(member.pid, member);
    const escaped = [];
    for (const tracked of known.values()) {
      try {
        const current = readStat(tracked.pid);
        if (current.startTicks === tracked.startTicks && current.processGroupId !== child.pid && alive(current)) {
          escaped.push({ pid: current.pid, startTicks: current.startTicks, processGroupId: current.processGroupId });
        }
      } catch (error) {
        if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error;
      }
    }
    return { group, live: group.filter(alive), escaped };
  }
  async function waitForDrain(milliseconds) {
    const deadline = performance.now() + milliseconds;
    let state;
    do {
      state = inspect();
      if (!state.live.length && reaped) return state;
      if (performance.now() >= deadline) return state;
      await delay(25);
    } while (true);
  }
  async function cleanup() {
    if (spawnFailed) return { status: 'spawn-failed', reaped, escalated: false };
    if (initialError && known.size === 0) throw initialError;
    let state = await waitForDrain(200);
    let sentTerm = false;
    let escalated = false;
    if (state.live.length) {
      // inspect() has verified both launch identity and membership immediately
      // before each signal. No PID outside this process group is signaled.
      state = inspect();
      if (state.live.length) {
        try { process.kill(-child.pid, 'SIGTERM'); sentTerm = true; }
        catch (error) { if (error.code !== 'ESRCH') throw error; }
      }
      state = await waitForDrain(750);
    }
    if (state.live.length) {
      state = inspect();
      if (state.live.length) {
        try { process.kill(-child.pid, 'SIGKILL'); escalated = true; }
        catch (error) { if (error.code !== 'ESRCH') throw error; }
      }
      state = await waitForDrain(750);
    }
    if (state.live.length || state.escaped.length || !reaped) {
      const error = new Error('Benchmark cleanup could not establish a quiescent process tree');
      error.cleanup = { live: state.live.map(process => ({ pid: process.pid, startTicks: process.startTicks })),
        escaped: state.escaped, reaped, sentTerm, escalated };
      throw error;
    }
    return { status: 'drained', reaped, sentTerm, escalated,
      remainingZombiePids: state.group.filter(process => !alive(process)).map(process => process.pid) };
  }
  return { observe, cleanup };
}

module.exports = { trackChild };
