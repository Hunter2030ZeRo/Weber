const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const profile = await (await fetch('/profile.json')).json();
const profileHash = (await (await fetch('/profile.sha256')).text()).trim();
const report = { profile: profile.id, profileHash, createdAt: new Date().toISOString(), backend: 'actual Servo Wayland; DISPLAY unset', cases: [], scenarios: Object.fromEntries(profile.mandatory_scenarios.map(name => [name, { status: 'NOT_RUN' }])), passed: false };
const timeout = (promise, ms) => Promise.race([promise, delay(ms).then(() => { throw new Error('WPT deadline exceeded'); })]);
await timeout(new Promise(resolve => {
  window.addEventListener('weber:profile-ready', resolve, { once: true });
  location.href = 'weber://dom-profile';
}), 10000);
for (const [index, file] of profile.tests.entries()) {
  const entry = { file, servo: null, aot: null };
  report.cases.push(entry);
  const frame = document.createElement('iframe');
  frame.width = '1024'; frame.height = '768';
  let onMessage;
  try {
    entry.servo = await timeout(new Promise((resolve, reject) => {
      // The original harness posts complete to its parent and supports replay.
      // Late add_completion_callback registration can miss fast files entirely.
      onMessage = event => {
        if (event.source !== frame.contentWindow || event.origin !== location.origin || event.data?.type !== 'complete') return;
        const { tests, status } = event.data;
        resolve({ complete: true, harness: { status: status.status, message: status.message }, tests: tests.map(test => ({ name: test.name, status: test.status, message: test.message })) });
      };
      window.addEventListener('message', onMessage);
      frame.onload = () => frame.contentWindow.postMessage({ type: 'getmessages' }, location.origin);
      frame.src = file.endsWith('.js') ? `/__any/${index}` : `/wpt/${file}`;
      document.body.append(frame);
    }), 10000);
  } catch (error) { entry.servo = { complete: false, error: String(error) }; }
  window.removeEventListener('message', onMessage);
  frame.remove();
  try {
    entry.aot = window.__weberDom.request('wpt-start', { index }).data;
    const deadline = performance.now() + 10000;
    while (!entry.aot?.complete && performance.now() < deadline) {
      await delay(25);
      entry.aot = window.__weberDom.request('wpt-status').data;
    }
    if (!entry.aot?.complete) entry.aot = { ...entry.aot, error: 'WPT deadline exceeded' };
  } catch (error) { entry.aot = { complete: false, error: String(error) }; }
  // Persist every case, including failures; a crashed later case cannot erase it.
  await fetch('/__results', { method: 'POST', body: JSON.stringify(report) });
  document.title = `Weber profile ${index + 1}/${profile.tests.length}`;
}
try {
  let data = window.__weberDom.request('profile-start').data;
  const nativeChecks = {};
  const check = (name, callback) => {
    try { callback(); nativeChecks[name] = { status: 'PASS' }; }
    catch (error) { nativeChecks[name] = { status: 'FAIL', error: String(error) }; }
  };
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  check('namespaces-and-dataset', () => {
    const node = document.getElementById('weber-profile-attributes');
    assert(node.getAttributeNS('urn:weber:first', 'x') === null && node.getAttributeNS('urn:weber:second', 'x') === 'final' && node.dataset.userName === 'Ada' && !node.hasAttribute('data-number'), 'Real Servo namespace/dataset state');
  });
  check('computed-style-and-client-rects', () => {
    const node = document.getElementById('weber-profile-rect'), rect = node.getBoundingClientRect();
    assert(rect.left === 17 && rect.top === 20 && rect.width === 144 && getComputedStyle(node).color === 'rgb(17, 34, 51)', 'Real Servo layout after AOT queries');
  });
  check('scroll-and-viewport', () => { const node = document.getElementById('weber-profile-scroll'); assert(node.scrollTop === 35 && node.scrollLeft === 23, 'Real scrolled position'); });
  check('focus-and-active-element', () => { assert(document.activeElement === document.body, 'Native blur restored document body'); });
  check('typed-ui-events', () => {
    const button = document.getElementById('weber-profile-button'), input = document.getElementById('weber-profile-input');
    const mouse = new MouseEvent('click', { bubbles: true, cancelable: true, clientX: 23, button: 1, buttons: 4, ctrlKey: true });
    button.dispatchEvent(mouse); assert(mouse.defaultPrevented, 'AOT mouse cancellation');
    const keyboard = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: '한', code: 'KeyG', repeat: true, shiftKey: true });
    input.dispatchEvent(keyboard); assert(keyboard.defaultPrevented, 'AOT keyboard cancellation');
    input.value = '입력'; input.dispatchEvent(new InputEvent('input', { bubbles: true, data: '한', inputType: 'insertText', isComposing: true }));
  });
  const deadline = performance.now() + 15000;
  do {
    await delay(25); data = window.__weberDom.request('profile-status').data;
  } while (Object.values(data.scenarios).some(result => result.status === 'PENDING') && performance.now() < deadline);
  for (const [name, result] of Object.entries(data.scenarios)) {
    report.scenarios[name] = { ...result, aot: result, native: nativeChecks[name] ?? null };
    if (nativeChecks[name]?.status === 'FAIL') report.scenarios[name].status = 'FAIL';
  }
  if (data.listenerErrors.length) report.listenerErrors = data.listenerErrors;
  try {
    window.__weberDom.request('profile-arm-disposal');
    const pending = window.__weberDom.snapshot();
    assert(pending.requests === 1 && pending.resizeObservers === 1 && pending.tasks === 1, 'Actual pending async operations before disposal');
    window.__weberDom.call('dispose');
    const disposed = window.__weberDom.snapshot();
    assert(disposed.epoch === 0 && disposed.requests === 0 && disposed.resizeObservers === 0 && disposed.tasks === 0 && disposed.nodes === 1, 'Native async registries disposed');
    window.__weberDom.call('browser');
    await delay(600);
    const after = window.__weberDom.request('profile-status').data;
    assert(after.disposalCallbacks === 0 && after.disposalFetchRejected && after.registries.fetch === 0 && after.registries.resizeObservers === 0, 'AOT registries released; old callbacks cannot reach the fresh document');
    report.disposal = { status: 'PASS', pending, disposed, callbacksAfterRemount: after.disposalCallbacks, pendingFetchRejected: after.disposalFetchRejected };
  } catch (error) {
    report.disposal = { status: 'FAIL', error: String(error) };
    report.scenarios['resize-observer-lifecycle'].status = 'FAIL';
    report.scenarios['fetch-abort-and-failure'].status = 'FAIL';
  }
} catch (error) { report.scenarioError = String(error); }
const passes = result => result?.complete && !result.error && result.harness?.status === 0 && result.tests?.length > 0 && result.tests.every(test => test.status === 0);
report.passed = report.cases.length === profile.tests.length && report.cases.every(entry => passes(entry.servo) && passes(entry.aot)) && Object.values(report.scenarios).every(result => result.status === 'PASS');
await fetch('/__results', { method: 'POST', body: JSON.stringify(report) });
document.title = `Weber profile ${report.passed ? 'PASS' : 'FAIL'}`;
location.href = 'weber://close';
