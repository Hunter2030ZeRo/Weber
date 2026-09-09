#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const readline = require('node:readline');
const { performance } = require('node:perf_hooks');
const { snapshot, ticksPerSecond, idleCpu } = require('./proc-tree.cjs');
const { collectProvenance } = require('./provenance.cjs');
const { trackChild } = require('./process-cleanup.cjs');

function options() {
  const values = { runs: '3', node: process.execPath,
    bootstrap: path.join(__dirname, '../electron-runtime/bootstrap.cjs'),
    output: path.join(__dirname, '../../weber-benchmark-result.json') };
  const known = new Set(['electron', 'node', 'bootstrap', 'output', 'runs']);
  const args = process.argv.slice(2);
  while (args.length) {
    const flag = args.shift();
    if (!flag.startsWith('--') || !known.has(flag.slice(2)) || args.length === 0) throw new Error(`Invalid benchmark argument ${flag}`);
    values[flag.slice(2)] = args.shift();
  }
  if (!values.electron) throw new Error('Pass --electron /absolute/path/to/the/Electron/binary');
  values.runs = Number(values.runs);
  if (!Number.isInteger(values.runs) || values.runs < 1 || values.runs > 10) throw new Error('--runs must be between 1 and 10');
  for (const key of ['electron', 'node', 'bootstrap', 'output']) {
    if (!path.isAbsolute(values[key])) throw new Error(`--${key} must be an absolute path`);
  }
  return values;
}
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
function median(values) {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

async function trial(framework, index, config, clockTicks) {
  const app = path.join(__dirname, 'app');
  const environment = { ...process.env, WEBER_UNSANDBOXED_DEVELOPMENT: '1' };
  // Do not let the caller's selector override the identical benchmark entry.
  delete environment.WEBER_ENTRY;
  delete environment.ELECTRON_RUN_AS_NODE;
  const executable = framework === 'electron' ? config.electron : config.node;
  const args = framework === 'electron' ? ['--no-sandbox', app] : [config.bootstrap, app];
  const messages = [];
  const waiters = [];
  const stderr = [];
  let exited;
  const started = performance.now();
  const child = spawn(executable, args, { env: environment, shell: false,
    detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const tracked = trackChild(child);
  let completedTrial;
  let failure;
  const exit = new Promise((resolve, reject) => {
    child.once('error', error => {
      exited = { error: error.message };
      for (const wake of waiters.splice(0)) wake();
      reject(error);
    });
    child.once('exit', (code, signal) => {
      exited = { code, signal };
      for (const wake of waiters.splice(0)) wake();
      resolve(exited);
    });
  });
  exit.catch(() => {});
  child.stdin.on('error', () => {});
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => {
    stderr.push(chunk);
    while (stderr.join('').length > 16384 && stderr.length > 1) stderr.shift();
  });
  const output = readline.createInterface({ input: child.stdout });
  output.on('line', line => {
    if (!line.startsWith('WEBER_BENCHMARK ')) return;
    try {
      const message = { ...JSON.parse(line.slice('WEBER_BENCHMARK '.length)), receivedMs: performance.now() };
      console.log(`[${framework} trial ${index}] ${message.phase}${message.stage ? `: ${message.stage}` : ''}`);
      messages.push(message);
    }
    catch (error) { messages.push({ phase: 'error', error: `Invalid benchmark output: ${error.message}` }); }
    for (const wake of waiters.splice(0)) wake();
  });
  const timeout = setTimeout(() => {
    messages.push({ phase: 'error', error: 'Benchmark trial exceeded 130 seconds' });
    for (const wake of waiters.splice(0)) wake();
  }, 130000);
  async function phase(name) {
    while (true) {
      const error = messages.find(message => message.phase === 'error');
      if (error) throw new Error(error.error);
      const position = messages.findIndex(message => message.phase === name);
      if (position >= 0) return messages.splice(position, 1)[0];
      if (exited) throw new Error(`Application exited before ${name}: ${JSON.stringify(exited)}\n${stderr.join('')}`);
      await new Promise(resolve => waiters.push(resolve));
    }
  }
  try {
    const ready = await phase('ready');
    if (framework === 'electron' && ready.versions.electron !== '42.0.0') {
      throw new Error(`Expected pinned Electron 42.0.0; got ${ready.versions.electron}`);
    }
    const startupToLoadAndCaptureMs = ready.receivedMs - started;
    tracked.observe(snapshot(child.pid));
    child.stdin.write('{"command":"measure"}\n');
    const workload = await phase('workload');
    await phase('idle-ready');
    const samples = [];
    const startIdle = performance.now();
    for (let sample = 0; sample < 5; sample++) {
      if (sample > 0) await delay(500);
      const startedAtMs = performance.now();
      const value = snapshot(child.pid);
      tracked.observe(value);
      samples.push({ ...value, elapsedMs: startedAtMs - startIdle });
    }
    const idleElapsedMs = samples.at(-1).elapsedMs - samples[0].elapsedMs;
    const idle = idleCpu(samples[0], samples.at(-1), idleElapsedMs, clockTicks);
    const identity = sample => sample.processes.map(process => `${process.pid}:${process.startTicks}`).join(',');
    if (samples.some(sample => identity(sample) !== identity(samples[0]))) {
      Object.assign(idle, { stableProcessSet: false, cpuTimeMs: null, oneCorePercent: null,
        reason: 'The observed process tree changed during idle sampling; CPU delta is omitted' });
    }
    child.stdin.write('{"command":"finish"}\n');
    await phase('complete');
    const status = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Application sent complete but did not exit within 5 seconds')), 5000);
      exit.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
    });
    if (status.code !== 0) throw new Error(`Application exited unsuccessfully: ${JSON.stringify(status)}\n${stderr.join('')}`);
    completedTrial = { framework, trial: index, startupToLoadAndCaptureMs,
      versions: ready.versions, rendererPids: ready.rendererPids,
      javascriptRoundTripMs: workload.javascriptRoundTripMs,
      ipcRoundTripMs: workload.ipcRoundTripMs,
      domUpdateAndCaptureMs: workload.domUpdateAndCaptureMs,
      idle: { ...idle, elapsedMs: idleElapsedMs,
        completeMemorySamples: samples.filter(sample => sample.errors.length === 0).length,
        pssBytesMedian: median(samples.map(sample => sample.pssBytes)),
        rssBytesMedian: median(samples.map(sample => sample.rssBytes)), samples },
      stderrTail: stderr.join('').slice(-8192),
    };
    return completedTrial;
  } catch (error) {
    failure = error;
    error.stderrTail = stderr.join('').slice(-8192);
    throw error;
  } finally {
    clearTimeout(timeout);
    child.stdin.destroy();
    try {
      const cleanup = await tracked.cleanup();
      if (completedTrial) completedTrial.cleanup = cleanup;
      if (failure) failure.cleanup = cleanup;
    } catch (cleanupError) {
      if (failure) failure.cleanup = cleanupError.cleanup || { error: cleanupError.message };
      else { cleanupError.stderrTail = stderr.join('').slice(-8192); throw cleanupError; }
    } finally {
      output.close();
      child.stdout.destroy();
      child.stderr.destroy();
    }
  }
}

function summarize(trials) {
  const summary = {};
  for (const framework of ['electron', 'weber']) {
    const samples = trials.filter(trial => trial.framework === framework);
    summary[framework] = {
      trials: samples.length,
      startupToLoadAndCaptureMs: median(samples.map(sample => sample.startupToLoadAndCaptureMs)),
      javascriptRoundTripMs: median(samples.flatMap(sample => sample.javascriptRoundTripMs)),
      ipcRoundTripMs: median(samples.flatMap(sample => sample.ipcRoundTripMs)),
      domUpdateAndCaptureMs: median(samples.flatMap(sample => sample.domUpdateAndCaptureMs)),
      idlePssBytes: median(samples.map(sample => sample.idle.pssBytesMedian)),
      idleRssBytes: median(samples.map(sample => sample.idle.rssBytesMedian)),
      idleCpuOneCorePercent: median(samples.map(sample => sample.idle.oneCorePercent)),
    };
  }
  summary.weberDividedByElectron = {};
  for (const key of Object.keys(summary.weber)) {
    if (key === 'trials') continue;
    const baseline = summary.electron[key];
    const measured = summary.weber[key];
    summary.weberDividedByElectron[key] = Number.isFinite(baseline) && baseline > 0 && Number.isFinite(measured) ? measured / baseline : null;
  }
  return summary;
}

async function main() {
  if (process.platform !== 'linux') throw new Error('Process-tree comparison currently requires Linux');
  if (Number(fs.readlinkSync('/proc/self')) !== process.pid) {
    throw new Error('Cannot measure process trees: /proc and process.pid use different PID namespaces');
  }
  const config = options();
  const clockTicks = ticksPerSecond();
  const provenance = await collectProvenance(config, path.join(__dirname, 'app'));
  const report = { schemaVersion: 1, createdAt: new Date().toISOString(),
    provenance,
    environment: { platform: process.platform, architecture: process.arch, release: os.release(),
      cpuCount: os.availableParallelism(), clockTicksPerSecond: clockTicks, display: process.env.DISPLAY || null },
    conditions: { pinnedElectron: '42.0.0', trialsPerFramework: config.runs, windows: 2,
      applicationFilesIdentical: true, osSandboxEnabled: false, contextIsolation: true,
      startupDefinition: 'spawn through loadFile, ready-to-show, show, two animation frames and captures for both windows, including preload setup',
      idleDefinition: 'five full descendant-tree samples, 500 ms apart, after 500 ms settling',
      pssDefinition: 'sum of all descendant smaps_rollup Pss; shared mappings apportioned by the kernel',
      rssDefinition: 'sum of all descendant smaps_rollup Rss; shared mappings may be counted more than once',
      cpuDefinition: 'sum of per-process user+system ticks; 100% means one fully occupied logical CPU',
      launchOrder: 'alternates per trial; operating-system page caches are not flushed',
      scope: 'small local HTML fixture under the current display; not a VS Code, general web compatibility, or production sandbox benchmark' },
    complete: false, trials: [], summary: null };
  const save = () => {
    fs.mkdirSync(path.dirname(config.output), { recursive: true });
    fs.writeFileSync(config.output, JSON.stringify(report, null, 2) + '\n');
  };
  for (let index = 0; index < config.runs; index++) {
    const order = index % 2 === 0 ? ['electron', 'weber'] : ['weber', 'electron'];
    for (const framework of order) {
      console.log(`Benchmark ${framework}, trial ${index + 1}/${config.runs}`);
      let result;
      try { result = await trial(framework, index + 1, config, clockTicks); }
      catch (error) {
        report.failure = { framework, trial: index + 1, error: error.stack || String(error),
          cleanup: error.cleanup, stderrTail: error.stderrTail };
        save();
        if (error.stderrTail) console.error(`Benchmark application stderr:\n${error.stderrTail}`);
        throw error;
      }
      report.trials.push(result);
      const firstSample = result.idle.samples[0];
      const lastSample = result.idle.samples.at(-1);
      const firstProcesses = new Map(firstSample.processes.map(value => [`${value.pid}:${value.startTicks}`, value]));
      console.log(JSON.stringify({ kind: 'process-cost', framework, trial: index + 1,
        elapsedMs: result.idle.elapsedMs,
        processes: lastSample.processes.map(value => {
          const initial = firstProcesses.get(`${value.pid}:${value.startTicks}`);
          return { pid: value.pid, name: value.name, pssBytes: value.pssBytes,
            cpuTimeMs: initial ? (value.ticks - initial.ticks) * 1000 / clockTicks : null };
        }) }));
      report.summary = summarize(report.trials);
      save();
      await delay(300);
    }
  }
  report.complete = true;
  save();
  console.log(JSON.stringify(report.summary, null, 2));
}

main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
