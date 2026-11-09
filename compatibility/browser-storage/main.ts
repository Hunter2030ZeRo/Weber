import { defineApp } from '@weber/runtime';
import profile from './profile.json';
type Scenario = { step: string; command: string; expected: string | null; foreignOrigin: string };
const name = 'weber-browser-storage-acceptance';
const report = (data: object) => (window as any).weberHostCall(JSON.stringify({ action: 'telemetry', data }));
const require = (value: unknown, message: string) => { if (!value) throw new Error(message); };
function request<T>(operation: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    operation.onsuccess = () => resolve(operation.result);
    operation.onerror = event => { event.preventDefault(); reject(operation.error); };
  });
}
async function open(version: number) {
  const opening = indexedDB.open(name, version);
  opening.onupgradeneeded = () => {
    if (!opening.result.objectStoreNames.contains('files')) opening.result.createObjectStore('files');
    if (version === 2 && !opening.result.objectStoreNames.contains('metadata')) opening.result.createObjectStore('metadata');
  };
  return request(opening);
}
async function read(database: IDBDatabase) {
  return request(database.transaction('files').objectStore('files').get('document'));
}
async function write(database: IDBDatabase, value: string) {
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction('files', 'readwrite');
    transaction.oncomplete = () => resolve(); transaction.onabort = transaction.onerror = () => reject(transaction.error);
    transaction.objectStore('files').put({ value, bytes: new Uint8Array([0, 37, 255]).buffer }, 'document');
  });
}
function verify(value: any, expected: string | null) {
  if (expected === null) require(value === undefined, 'Unexpected record from another app or deleted database');
  else {
    require(value?.value === expected, 'Persisted record differs');
    require(JSON.stringify([...new Uint8Array(value.bytes)]) === '[0,37,255]', 'Persisted ArrayBuffer differs');
  }
}
async function workerRead(expected: string, fromBlob = false) {
  const url = fromBlob ? URL.createObjectURL(new Blob([await (await fetch('/db-worker.js')).text()], { type: 'text/javascript' })) : '/db-worker.js';
  if (fromBlob) require(new URL(url).origin === location.origin, 'Blob URL origin differs');
  const worker = new Worker(url);
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('IndexedDB worker timed out')), 7000);
      worker.onerror = event => { event.preventDefault(); clearTimeout(timer); reject(new Error(event.message)); };
      worker.onmessage = event => {
        clearTimeout(timer);
        try { require(!event.data.error, String(event.data.error)); verify(event.data.record, expected); require(event.data.origin === location.origin, 'Worker origin differs'); resolve(event.data.origin); } catch (error) { reject(error); }
      };
      worker.postMessage(name);
    });
  } finally { worker.terminate(); if (fromBlob) URL.revokeObjectURL(url); }
}
defineApp({ title: 'Weber browser storage acceptance', mount(root) {
  root.textContent = 'Checking native app browser storage…';
  void (async () => {
    report({ stage: 'ready', title: document.title });
    const scenario = await (await fetch('/scenario.json')).json() as Scenario;
    require(profile.required.includes(scenario.step), 'Unexpected scenario');
    require(location.origin !== 'null' && new URL(location.href).origin === location.origin, 'Application origin is not stable/consistent');
    try {
      const foreign = await fetch(scenario.foreignOrigin + '/web.js');
      require(!foreign.ok, 'Other application assets were served');
    } catch (error) { if (!(error instanceof TypeError)) throw error; }
    let database: IDBDatabase | undefined;
    try {
      if (scenario.command === 'delete' || scenario.command === 'delete-missing') {
        await new Promise<void>((resolve, reject) => {
          const deleting = indexedDB.deleteDatabase(name);
          deleting.onerror = () => reject(deleting.error);
          deleting.onsuccess = event => {
            try { require((event as IDBVersionChangeEvent).oldVersion === (scenario.command === 'delete' ? 2 : 0), 'Deleted database version differs'); resolve(); }
            catch (error) { reject(error); }
          };
        });
      }
      else if (scenario.command === 'old-version') {
        let rejected = false;
        try { database = await open(1); } catch (error) { rejected = (error as DOMException).name === 'VersionError'; }
        require(rejected, 'Older database version did not reject');
      } else {
        database = await open(scenario.command === 'upgrade' ? 2 : 1);
        if (scenario.command === 'write') await write(database, scenario.expected!);
        verify(await read(database), scenario.expected);
        if (scenario.command === 'upgrade') require(database.objectStoreNames.contains('metadata'), 'Upgrade store missing');
      }
    } finally { database?.close(); }
    let workerOrigin, blobWorkerOrigin;
    if (scenario.command === 'write') {
      workerOrigin = await workerRead(scenario.expected!);
      blobWorkerOrigin = await workerRead(scenario.expected!, true);
    }
    root.textContent = `Passed: ${scenario.step}`;
    report({ stage: 'browser-storage-result', passed: true, step: scenario.step, origin: location.origin, workerOrigin, blobWorkerOrigin, profile: profile.id });
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); location.href = 'weber://close';
  })().catch(error => {
    root.textContent = String(error); report({ stage: 'browser-storage-result', passed: false, error: String(error), profile: profile.id }); location.href = 'weber://close';
  });
} });
