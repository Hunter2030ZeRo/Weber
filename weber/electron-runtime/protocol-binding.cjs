// Copyright Weber contributors. SPDX-License-Identifier: MIT
'use strict';
const { EventEmitter } = require('node:events');
const path = require('node:path');
const { Readable } = require('node:stream');
const { WebRequest, requestDetails } = require('./web-request.cjs');
const mime = new Map(Object.entries({ '.html':'text/html', '.js':'text/javascript', '.mjs':'text/javascript', '.css':'text/css', '.json':'application/json', '.svg':'image/svg+xml', '.png':'image/png', '.jpg':'image/jpeg', '.woff':'font/woff', '.woff2':'font/woff2', '.ttf':'font/ttf', '.wasm':'application/wasm' }));
const MAX_BUFFER = 512 * 1024;
function createProtocolBinding({ app, host, windows, unsupported }) {
  const privileges = new Map();
  const sessions = new Map();
  function scheme(value) {
    if (typeof value !== 'string' || !/^[a-z][a-z0-9+.-]{0,63}$/.test(value)) throw new TypeError('Invalid protocol scheme');
    if (['http','https','javascript','data','about','blob'].includes(value)) return unsupported(`protocol interception for ${value}`);
    return value;
  }
  class Protocol {
    constructor() { this.handlers = new Map(); }
    _register(name, handler, kind, intercepted, completion) {
      scheme(name);
      if (typeof handler !== 'function') throw new TypeError('Protocol handler must be a function');
      if (this.handlers.size >= 128) throw new RangeError('Protocol registry limit exceeded');
      const ok = !this.handlers.has(name);
      if (ok) { this.handlers.set(name, { handler, kind, intercepted }); this._changed(); }
      if (completion) queueMicrotask(() => completion(ok ? null : new Error('Protocol is already registered')));
      return ok;
    }
    _changed() {
      for (const win of windows.values()) if (win.webContents?.session?.protocol === this) {
        win.webContents._protocolReady = win.webContents._command({ method:'configureProtocols', schemes:this._rules() });
        win.webContents._protocolReady.catch(error => app.emit('weber-error', error));
      }
    }
    _rules() { return [...this.handlers.keys()].map(name => ({ scheme:name, ...(privileges.get(name) || {}) })); }
    unregisterProtocol(name, completion) { const ok=this.handlers.delete(scheme(name)); if(ok)this._changed(); if(completion)queueMicrotask(()=>completion(ok?null:new Error('Protocol not registered'))); return ok; }
    uninterceptProtocol(name, completion) { if(!this.isProtocolIntercepted(name))return false; return this.unregisterProtocol(name,completion); }
    isProtocolRegistered(name) { const entry=this.handlers.get(scheme(name)); return !!entry && !entry.intercepted; }
    isProtocolIntercepted(name) { return !!this.handlers.get(scheme(name))?.intercepted; }
  }
  for(const [suffix,kind] of [['File','file'],['String','string'],['Buffer','buffer'],['Stream','stream'],['','stream']]) {
    Protocol.prototype[`register${suffix}Protocol`] = function(name, handler, callback) { return this._register(name,handler,kind,false,callback); };
    Protocol.prototype[`intercept${suffix}Protocol`] = function(name, handler, callback) { return this._register(name,handler,kind,true,callback); };
  }
  for (const method of ['registerHttpProtocol','interceptHttpProtocol']) Protocol.prototype[method]=()=>unsupported(`protocol.${method}`);
  function registerSchemesAsPrivileged(values) {
    if (app.isReady()) throw new Error('Schemes must be registered before app is ready');
    if (!Array.isArray(values) || values.length > 128) throw new TypeError('Invalid scheme declarations');
    const next = new Map(privileges);
    for(const value of values) {
      const name=scheme(value.scheme), options=value.privileges || {};
      if (next.has(name)) throw new Error('Scheme privileges already registered');
      for(const [key,enabled] of Object.entries(options)) {
        if(!['standard','secure','supportFetchAPI','corsEnabled','allowServiceWorkers','codeCache','stream','bypassCSP'].includes(key) || typeof enabled !== 'boolean') throw new TypeError('Invalid scheme privilege');
        if(key === 'bypassCSP' && enabled) return unsupported('protocol bypassCSP');
      }
      next.set(name,{...options});
    }
    privileges.clear();for(const [name,value] of next)privileges.set(name,value);
  }
  class Session extends EventEmitter {
    constructor(partition) { super(); this.partition=partition; this.protocol=new Protocol(); this.webRequest=new WebRequest(); require('./session-permissions.cjs').attachSessionPermissions(this); }
  }
  const session={fromPartition(partition='') {
    if(typeof partition!=='string'||Buffer.byteLength(partition)>256)throw new TypeError('Invalid session partition');
    if(!sessions.has(partition))sessions.set(partition,new Session(partition));
    return sessions.get(partition);
  }, fromPath:()=>unsupported('session.fromPath')};
  Object.defineProperty(session,'defaultSession',{get:()=>session.fromPartition('')});
  async function normalize(result, kind, signal) {
    if(typeof result==='number')return {error:result};
    if(typeof result==='string')result=kind==='file'?{path:result}:{data:result};
    if(Buffer.isBuffer(result))result={data:result};
    if(!result||typeof result!=='object')throw new TypeError('Invalid protocol response');
    if(result.error!==undefined)return {error:result.error};
    const headers={};
    for(const [key,value] of Object.entries(result.headers||{})) {
      if(/[\r\n]/.test(key+String(value)))throw new TypeError('Invalid protocol header');
      headers[key.toLowerCase()]=Array.isArray(value)?value.join(', '):String(value);
    }
    const statusCode=result.statusCode??200;
    if(!Number.isInteger(statusCode)||statusCode<100||statusCode>599)throw new TypeError('Invalid protocol status');
    headers['content-type'] ||= result.mimeType || (kind==='file'?mime.get(path.extname(result.path||'')):'text/plain') || 'application/octet-stream';
    if(kind==='file') {
      if(typeof result.path!=='string'||!path.isAbsolute(result.path)||result.path.includes('\0'))throw new TypeError('Expected absolute protocol file path');
      return {path:result.path,headers,statusCode};
    }
    let data=result.data;
    if(data instanceof Readable || data?.[Symbol.asyncIterator]) {
      const chunks=[];let bytes=0;
      let stop;
      const cancelled=new Promise((_,reject)=>{stop=()=>{data.destroy?.();reject(new Error('Protocol resource cancelled'));};signal.addEventListener('abort',stop,{once:true});if(signal.aborted)stop();});
      const read=async()=>{for await(const chunk of data) {const part=Buffer.from(chunk);bytes+=part.length;if(bytes>MAX_BUFFER)throw new RangeError('Buffered protocol response exceeds 512 KiB; use registerFileProtocol for large files');chunks.push(part);}};
      try { await Promise.race([read(),cancelled]); }
      finally { signal.removeEventListener('abort',stop);data.destroy?.(); }
      data=Buffer.concat(chunks,bytes);
    } else data=Buffer.from(data??'',result.charset||'utf8');
    if(data.length>MAX_BUFFER)throw new RangeError('Buffered protocol response exceeds 512 KiB');
    return {data:data.toString('base64'),headers,statusCode};
  }
  host.on('event', message=>{
    if(message.event!=='resource-request')return;
    const win=windows.get(message.windowId);
    const wc=win?.webContents, owner=wc?.session;
    const protocol=owner?.protocol;
    const navigation=wc?._navigation;
    const abort=new AbortController();
    const cancel=()=>abort.abort();
    // Bound all policy, handler and stream stages below the engine's 25s resource deadline.
    const deadline=setTimeout(cancel,20000);
    app.once('quit',cancel);wc?.once('destroyed',cancel);wc?.once('did-start-loading',cancel);
    const live=()=>{if(abort.signal.aborted||!win||win.isDestroyed()||wc._navigation!==navigation)throw new Error('Resource owner is no longer active');};
    const handle=async()=>{
      live();
      const request={...message.request};
      const name=new URL(request.url).protocol.slice(0,-1);
      const entry=protocol?.handlers.get(name);
      if(!entry)throw new Error('Protocol is no longer registered for this session');
      if(request.body)request.uploadData=[{type:'rawData',bytes:Buffer.from(request.body,'base64')}];
      delete request.body;request.referrer ||= request.headers?.referer || '';
      const types={Document:'mainFrame',Stylesheet:'stylesheet',Script:'script',Image:'image',Font:'font',Fetch:'xhr',Xhr:'xhr',Media:'media'};
      const details=requestDetails({url:request.url,method:request.method||'GET',webContentsId:wc.id,webContents:wc,
        frame:wc.mainFrame,resourceType:types[request.resourceType]||'other', ...(request.uploadData?{uploadData:request.uploadData}:{})});
      const before=await owner.webRequest._dispatch('onBeforeRequest',details,abort.signal);
      live();
      if(before.cancel)throw new Error('net::ERR_BLOCKED_BY_CLIENT');
      if(before.redirectURL&&before.redirectURL!==request.url)throw new Error('Weber has not implemented custom-protocol webRequest redirects');
      const result=await new Promise((resolve,reject)=>{
        let completed=false;
        const finish=(error,value)=>{if(completed)return;completed=true;abort.signal.removeEventListener('abort',stop);if(error)reject(error);else resolve(value);};
        const stop=()=>finish(new Error('Protocol handler cancelled or timed out'));
        abort.signal.addEventListener('abort',stop,{once:true});
        if(abort.signal.aborted)return stop();
        const done=value=>finish(null,value);
        try { Promise.resolve(entry.handler(request,done)).catch(error=>finish(error)); }
        catch(error){finish(error);}
      });
      live();
      const response=await normalize(result,entry.kind,abort.signal);
      if(response.error!==undefined)return response;
      const headers=await owner.webRequest._dispatch('onHeadersReceived',{...details,statusCode:response.statusCode,
        statusLine:`HTTP/1.1 ${response.statusCode}`,responseHeaders:Object.fromEntries(Object.entries(response.headers).map(([key,value])=>[key,[value]])),fromCache:false},abort.signal);
      live();
      if(headers.cancel)throw new Error('net::ERR_BLOCKED_BY_CLIENT');
      if(headers.responseHeaders)response.headers=Object.fromEntries(Object.entries(headers.responseHeaders).map(([key,value])=>[key,value.join(', ')]));
      if(headers.statusLine)response.statusCode=Number(headers.statusLine.split(' ')[1]);
      return response;
    };
    handle().catch(error=>({error:String(error?.message||error)})).then(response=>
      host.request('resource.reply',{windowId:message.windowId,resourceId:message.resourceId,response})
    ).catch(error=>{if(win&&!win.isDestroyed())app.emit('weber-error',error);})
      .finally(()=>{clearTimeout(deadline);app.removeListener('quit',cancel);wc?.removeListener('destroyed',cancel);wc?.removeListener('did-start-loading',cancel);});
  });
  return {session, Session, binding:{Protocol,registerSchemesAsPrivileged,getStandardSchemes:()=>[...privileges].filter(([,v])=>v.standard).map(([name])=>name)}};
}
module.exports={createProtocolBinding};
