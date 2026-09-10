import { net } from 'electron';
import { net as utilityNet } from 'electron/utility';
import assert from 'node:assert/strict';
import fixture from './net.cjs';

assert.equal(net, utilityNet);
await fixture.exercise(net, 'esm');
