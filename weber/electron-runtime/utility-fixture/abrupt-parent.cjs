// Spawned by the parent-death regression. It must not signal unrelated PIDs.
const { EventEmitter } = require('node:events');
const path = require('node:path');
const app = new EventEmitter(); app.isReady = () => true;
app.on('weber-error', error => { console.error(error); process.exit(1); });
const binding = require('../utility-binding.cjs').createUtilityBinding({ app, unsupported: name => { throw Error(name); } });
const child = binding._fork({ modulePath: path.join(__dirname, 'child.cjs'), args: [], options: { stdio: ['ignore','ignore','ignore'] } });
let identity;
child.emit = (name, data) => {
  if (name !== 'message') return;
  if (data && typeof data === 'object') {
    identity = data; child.postMessage({ kind: 'busy' });
  } else if (data === 'busy') process.stdout.write(JSON.stringify(identity) + '\n');
};
child.postMessage({ kind: 'process-identity' });
