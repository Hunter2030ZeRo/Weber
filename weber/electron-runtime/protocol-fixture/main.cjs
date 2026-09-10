'use strict';
const { app, BrowserWindow, protocol, session }=require('electron');
const assert=require('node:assert/strict');
const path=require('node:path');
const fs=require('node:fs');
const { once }=require('node:events');
let done=false;
const timer=setTimeout(()=>finish(new Error('Protocol acceptance timed out')),60000);
function finish(error, details={}) {if(done)return;done=true;clearTimeout(timer);console.log(JSON.stringify({kind:'protocol-acceptance',ok:!error,error:error?.stack,...details}));app.exit(error?1:0);}
const requested=[];
protocol.registerSchemesAsPrivileged([{scheme:'weber-test',privileges:{standard:true,secure:true,supportFetchAPI:true,corsEnabled:true}}]);
assert.deepEqual(protocol.getStandardSchemes(),['weber-test']);
protocol.registerFileProtocol('weber-test',(request,callback)=>{
  requested.push(request.url);
  const url=new URL(request.url);
  const target=path.resolve(__dirname,decodeURIComponent(url.pathname).replace(/^\//,''));
  if(!target.startsWith(__dirname+path.sep))return callback({error:-3});
  callback({path:target,headers:{'x-weber-protocol':'actual-native-file'}});
});
session.defaultSession.protocol.interceptFileProtocol('file',(_request,callback)=>callback({error:-3}));
app.whenReady().then(async()=>{
  const first=new BrowserWindow({width:600,height:400});
  const presented=once(first.webContents,'weber-first-frame-presented');
  await first.loadURL('weber-test://app/index.html');await presented;
  assert.equal(await first.webContents.executeJavaScript('moduleLoaded'),42);
  assert.equal(await first.webContents.executeJavaScript("getComputedStyle(document.querySelector('#answer')).color"),'rgb(12, 34, 56)');
  assert.equal(await first.webContents.executeJavaScript("new URL(location.href).origin"),'weber-test://app');
  const fetchResult=await first.webContents.executeJavaScript("fetch('weber-test://app/classic.js').then(async r=>({status:r.status,text:await r.text(),header:r.headers.get('x-weber-protocol')}))");
  assert.equal(fetchResult.status,200);assert.match(fetchResult.text,/classicLoaded/);assert.equal(fetchResult.header,'actual-native-file');
  const policy=session.defaultSession.webRequest;
  policy.onBeforeRequest({urls:['weber-test://app/classic.js']},(_details,callback)=>callback({cancel:true}));
  const beforeCount=requested.length;
  assert.equal(await first.webContents.executeJavaScript("fetch('weber-test://app/classic.js').then(()=>false,()=>true)"),true);
  assert.equal(requested.length,beforeCount);
  policy.onBeforeRequest(null);
  policy.onHeadersReceived({urls:['weber-test://app/classic.js']},(details,callback)=>callback({responseHeaders:{...details.responseHeaders,'x-session-policy':['enforced']}}));
  assert.equal(await first.webContents.executeJavaScript("fetch('weber-test://app/classic.js').then(r=>r.headers.get('x-session-policy'))"),'enforced');
  policy.onHeadersReceived(null);
  assert.equal(await first.webContents.executeJavaScript("fetch('weber-test://other/classic.js').then(()=>false,()=>true)"),true);
  await assert.rejects(first.loadFile('index.html'), /-3|Blocked|blocked/);
  // A separate partition has no handler until it explicitly registers one.
  const separate=session.fromPartition('isolated-test');
  assert.notEqual(separate,session.defaultSession);assert.equal(separate.protocol.isProtocolRegistered('weber-test'),false);
  const second=new BrowserWindow({webPreferences:{partition:'isolated-test'}});
  await assert.rejects(second.loadURL('weber-test://app/index.html'),/scheme|protocol/i);
  separate.protocol.registerStringProtocol('weber-test',(_r,callback)=>callback({mimeType:'text/html',data:'<title>Separate session</title><body>partition</body>'}));
  await second.loadURL('weber-test://app/index.html');
  assert.equal(await second.webContents.executeJavaScript('document.title'),'Separate session');
  // Actual standard Electron protocol.handle wrapper creates Request/Response.
  separate.protocol.unregisterProtocol('weber-test');
  separate.protocol.handle('weber-test',request=>new Response('<title>Response handler</title>',{headers:{'content-type':'text/html'}}));
  await second.loadURL('weber-test://app/index.html');
  assert.equal(await second.webContents.executeJavaScript('document.title'),'Response handler');
  for(const suffix of ['index.html','style.css','classic.js','module.mjs','dependency.mjs'])assert.ok(requested.some(url=>url.endsWith(suffix)),suffix);
  finish(null,{sourceModules:['protocol'],checked:['document','CSS','classic script','ES module graph','fetch','origin separation','file interception','partition ownership','Request/Response handle','session request cancellation','session response headers']});
}).catch(finish);
