import process from 'node:process';
process.parentPort.on('message', ({ data }) => {
  process.parentPort.postMessage({ esm: true, data, type: process.type });
});
