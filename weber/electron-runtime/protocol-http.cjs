// Copyright Weber contributors. SPDX-License-Identifier: MIT
'use strict';
const { createURLLoader } = require('./net-url-loader.cjs');
const MAX_BUFFER = 512 * 1024;

function forwardHttp(result, original, owner, Session, signal) {
  if (!result || typeof result !== 'object' || Array.isArray(result) || typeof result.url !== 'string') throw new TypeError('HTTP protocol response requires a URL');
  if (!(owner instanceof Session)) throw new TypeError('Invalid HTTP protocol session');
  const method = result.method ?? original.method ?? 'GET';
  const headers = { ...original.headers };
  // Framing describes the replacement body, never the intercepted body.
  for (const name of Object.keys(headers)) if (['content-length','transfer-encoding','host','referer'].includes(name.toLowerCase())) delete headers[name];
  if (result.referrer !== undefined) {
    if (typeof result.referrer !== 'string') throw new TypeError('Invalid protocol referrer');
    if (result.referrer) headers.referer = new URL(result.referrer).href;
  }
  let body;
  if (!['GET','HEAD'].includes(method) && result.uploadData !== undefined) {
    const upload = result.uploadData;
    if (!upload || typeof upload !== 'object' || typeof upload.contentType !== 'string' ||
        !(typeof upload.data === 'string' || Buffer.isBuffer(upload.data))) throw new TypeError('Invalid protocol uploadData');
    body = Buffer.from(upload.data);
    if (body.length > MAX_BUFFER) throw new RangeError('HTTP protocol upload exceeds 512 KiB');
    for (const name of Object.keys(headers)) if (name.toLowerCase() === 'content-type') delete headers[name];
    headers['content-type'] = upload.contentType;
  }
  if (signal.aborted) throw new Error('HTTP protocol cancelled');
  return new Promise((resolve, reject) => {
    let loader, settled = false, head, bytes = 0;
    const chunks = [];
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abort);
      if (error) { loader?.cancel(); reject(error); } else resolve(value);
    };
    const abort = () => finish(new Error('HTTP protocol cancelled'));
    try {
      loader = createURLLoader({ url: result.url, method, extraHeaders: headers, body }, {
        webRequest: owner.webRequest, agentFor: () => false,
      });
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) return abort();
      loader.on('error', (_event, message) => finish(new Error(message)));
      loader.on('response-started', (_event, _url, value) => { head = value; });
      loader.on('data', (_event, chunk, resume) => {
        bytes += chunk.length;
        if (bytes > MAX_BUFFER) return finish(new RangeError('HTTP protocol response exceeds 512 KiB'));
        chunks.push(Buffer.from(chunk)); resume();
      });
      loader.on('complete', () => {
        if (!head) return finish(new Error('HTTP protocol response missing headers'));
        // URLLoader already decoded compression and consumed transfer framing.
        const responseHeaders = Object.fromEntries(Object.entries(head.headers)
          .filter(([name]) => !['content-encoding','content-length','transfer-encoding','connection','keep-alive'].includes(name))
          .map(([name, values]) => [name, values.join(', ')]));
        finish(null, { data: Buffer.concat(chunks, bytes).toString('base64'), headers: responseHeaders, statusCode: head.statusCode });
      });
    } catch (error) { finish(error); }
  });
}
module.exports = { forwardHttp };
