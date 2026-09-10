const { parentPort } = process;
if (!parentPort || process.type !== 'utility') throw new Error('Missing original utility parentPort');
console.log('utility-stdout-ready');
console.error('utility-stderr-ready');
parentPort.on('message', event => {
  const request = event.data;
  if (request.kind === 'identity') parentPort.postMessage({ pid: process.pid, ppid: process.ppid,
    type: process.type, argv: process.argv.slice(2), cwd: process.cwd(), env: process.env.UTILITY_FIXTURE_VALUE });
  else if (request.kind === 'echo') parentPort.postMessage(request.data);
  else if (request.kind === 'process-identity') parentPort.postMessage({ pid: process.pid,
    procPid: require('node:fs').readlinkSync('/proc/self') });
  else if (request.kind === 'port') {
    if (event.ports.length !== 1) throw new Error('Expected transferred MessagePortMain');
    const port = event.ports[0];
    port.on('message', event => port.postMessage(event.data));
    port.on('close', () => parentPort.postMessage('port-closed'));
    setTimeout(() => port.start(), 25);
    parentPort.postMessage('port-received');
  } else if (request.kind === 'exit') process.exit(request.code);
  else if (request.kind === 'natural-exit') {
    parentPort.postMessage('final-message');
    parentPort.removeAllListeners('message');
  } else if (request.kind === 'busy') {
    parentPort.postMessage('busy');
    while (true) {} // Parent-death regression: EOF cannot stop blocked JS.
  } else throw new Error('Unknown utility fixture command');
});
