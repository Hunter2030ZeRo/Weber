// Same ordinary Electron utility entry in source and extracted bundle checks.
process.parentPort.on('message', event => {
  if (event.data === 'take-port') {
    const port = event.ports[0];
    if (!port) throw new Error('Missing transferred port');
    port.on('message', event => port.postMessage({ answer: event.data + 1, pid: process.pid }));
    port.start();
  } else if (event.data === 'stop') {
    process.parentPort.postMessage('stopped');
    setTimeout(() => process.exit(0), 20);
  }
});
