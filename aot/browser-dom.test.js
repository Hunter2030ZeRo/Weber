const document = globalThis.WeberBrowserDOM.createDocument();
const microtasks = [];
globalThis.queueMicrotask = callback => microtasks.push(callback);
const results = globalThis.runBrowserContracts(document, globalThis.WeberEvents.Event, globalThis.WeberObservers.MutationObserver);
while (microtasks.length) microtasks.shift()();
if (document.listenerErrors.length) throw new Error(document.listenerErrors.join("\n"));
const installed = globalThis.WeberBrowserDOM.installGlobals();
if (globalThis.document !== installed || !(installed.createTextNode("test") instanceof globalThis.Node) || !(new globalThis.Event("test") instanceof globalThis.Event)) throw new Error("Browser globals installation failed");
print(JSON.stringify({ passed: true, cases: results }));
