// Real utility entry: exercise auth through Electron's unmodified ClientRequest.
'use strict';
const { net } = require('electron');
const base = new URL(process.argv[2]);
const requests = new Map();

process.parentPort.on('message', ({ data }) => {
  if (data.kind === 'stop') { process.exit(0); return; }
  if (data.kind === 'abort') { requests.get(data.id)?.abort(); return; }
  if (data.kind !== 'request') throw new Error('Unknown auth fixture command');
  let logins = 0;
  const request = net.request({ url: new URL(data.path, base).href,
    ...(data.credentials ? { credentials: data.credentials } : {}) }, response => {
    const chunks = [];
    response.on('data', chunk => chunks.push(chunk));
    response.on('error', error => process.parentPort.postMessage({ kind: 'error', id: data.id, message: error.message }));
    response.once('end', () => {
      requests.delete(data.id);
      process.parentPort.postMessage({ kind: 'result', id: data.id, status: response.statusCode,
        body: Buffer.concat(chunks).toString(), logins });
    });
  });
  requests.set(data.id, request);
  request.on('login', (_info, callback) => {
    logins++;
    if (data.localAuth) callback('utility-user', 'utility-password');
    else callback();
  });
  request.on('error', error => {
    requests.delete(data.id);
    process.parentPort.postMessage({ kind: 'error', id: data.id, message: error.message });
  });
  request.once('abort', () => {
    requests.delete(data.id);
    process.parentPort.postMessage({ kind: 'aborted', id: data.id });
  });
  request.end();
});
process.parentPort.postMessage({ kind: 'ready', pid: process.pid });
