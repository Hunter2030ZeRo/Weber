// Copyright Weber contributors. SPDX-License-Identifier: MIT
'use strict';
const net = require('node:net');

// Bun 1.4.2 validates Socket({fd}) without adopting a duplex socket handle.
// Its connect({fd}) path attaches that handle asynchronously. Mark connecting
// first so writes issued by fork().postMessage() in the same turn are buffered.
// fdIsRawSocket selects the owned socketpair descriptor, not a Bun handle ID.
class Socket extends net.Socket {
  constructor(options = {}) {
    if (!process.versions.bun || options.fd === undefined) { super(options); return; }
    const { fd, ...rest } = options;
    super(rest);
    this.connecting = true;
    this.connect({ fd, fdIsRawSocket: true });
  }
}
module.exports = { Socket, net: { ...net, Socket } };
