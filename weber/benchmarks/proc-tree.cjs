'use strict';
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

// stat accounts only this process's user/system time. Including cutime/cstime
// as well would double-count child CPU when summing the descendant tree.
function readStat(pid) {
  const source = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
  const end = source.lastIndexOf(')');
  const fields = source.slice(end + 2).trim().split(/\s+/);
  return { pid, name: source.slice(source.indexOf('(') + 1, end),
    state: fields[0], ppid: Number(fields[1]), processGroupId: Number(fields[2]),
    sessionId: Number(fields[3]), ticks: Number(fields[11]) + Number(fields[12]),
    startTicks: fields[19], threads: Number(fields[17]) };
}

function memory(pid) {
  const source = fs.readFileSync(`/proc/${pid}/smaps_rollup`, 'utf8');
  function bytes(label) {
    const match = source.match(new RegExp(`^${label}:\\s+(\\d+)\\s+kB$`, 'm'));
    if (!match) throw new Error(`Missing ${label} in process ${pid} memory report`);
    return Number(match[1]) * 1024;
  }
  return { pssBytes: bytes('Pss'), rssBytes: bytes('Rss') };
}

function snapshot(rootPid) {
  const all = new Map();
  for (const name of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    try { all.set(pid, readStat(pid)); } catch (error) {
      if (!['ENOENT', 'ESRCH', 'EACCES'].includes(error.code)) throw error;
    }
  }
  if (!all.has(rootPid)) throw new Error('Benchmark root process disappeared before sampling');
  const included = new Set([rootPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const process of all.values()) {
      if (included.has(process.ppid) && !included.has(process.pid)) {
        included.add(process.pid);
        changed = true;
      }
    }
  }
  const processes = [];
  const errors = [];
  for (const pid of included) {
    const process = all.get(pid);
    try { processes.push({ ...process, ...memory(pid) }); }
    catch (error) { errors.push({ pid, reason: error.message }); processes.push(process); }
  }
  processes.sort((left, right) => left.pid - right.pid);
  return { processes, errors,
    pssBytes: errors.length ? null : processes.reduce((sum, process) => sum + process.pssBytes, 0),
    rssBytes: errors.length ? null : processes.reduce((sum, process) => sum + process.rssBytes, 0),
  };
}

function ticksPerSecond() {
  const value = Number(execFileSync('getconf', ['CLK_TCK'], { encoding: 'utf8' }).trim());
  if (!Number.isFinite(value) || value <= 0) throw new Error('Unable to read Linux CLK_TCK');
  return value;
}

function idleCpu(first, last, elapsedMs, clockTicks) {
  const identities = value => value.processes.map(process => `${process.pid}:${process.startTicks}`).join(',');
  if (identities(first) !== identities(last)) return {
    stableProcessSet: false, cpuTimeMs: null, oneCorePercent: null,
    reason: 'Process tree changed during idle measurement; CPU delta is omitted',
  };
  const ticks = value => value.processes.reduce((sum, process) => sum + process.ticks, 0);
  const delta = ticks(last) - ticks(first);
  if (delta < 0) throw new Error('Process CPU counter moved backwards');
  const cpuTimeMs = delta * 1000 / clockTicks;
  return { stableProcessSet: true, cpuTimeMs, oneCorePercent: cpuTimeMs / elapsedMs * 100 };
}

module.exports = { readStat, snapshot, ticksPerSecond, idleCpu };
