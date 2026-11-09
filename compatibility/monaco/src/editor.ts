import * as monaco from 'monaco-editor/editor/editor.api';
import * as typescript from 'monaco-editor/languages/features/typescript/register';
import 'monaco-editor/languages/definitions/typescript/register';
import 'monaco-editor/editor/contrib/find/browser/findController';
import EditorWorker from 'monaco-editor/editor/editor.worker?worker';
import TypeScriptWorker from 'monaco-editor/languages/features/typescript/ts.worker?worker';
import { report } from './main';
const require = (value: unknown, message: string) => { if (!value) throw new Error(message); };
const frames = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
const timeout = <T>(promise: Promise<T>, label: string) => Promise.race([promise, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(label + ' timed out')), 20000))]);
export async function run(root: HTMLElement) {
  const workers: Worker[] = [];
  let workerDiagnosticResponse = false;
  (self as any).MonacoEnvironment = { getWorker(_id: string, label: string) {
    const worker = label === 'typescript' || label === 'javascript' ? new TypeScriptWorker() : new EditorWorker();
    workers.push(worker); report({ stage: 'monaco-worker-created', label });
    worker.addEventListener('error', event => report({ stage: 'monaco-worker-error', label, message: event.message }));
    // Observe the pinned Monaco RPC reply on the actual Worker, so a main-thread
    // fallback cannot satisfy the diagnostics check merely by creating a worker.
    worker.addEventListener('message', event => {
      if ((label === 'typescript' || label === 'javascript') && Array.isArray(event.data?.res) && event.data.res.some((diagnostic: any) => diagnostic.code === 2322)) workerDiagnosticResponse = true;
    });
    return worker;
  } };
  root.innerHTML = '<style>html,body{margin:0;width:100%;height:100%;overflow:hidden}#aot-dom-root{width:100%;height:100%}#editor{width:100%;height:100%}</style><div id="editor"></div>';
  const container = root.querySelector<HTMLElement>('#editor')!;
  const model = monaco.editor.createModel('const answer: number = 42;\nconsole.log(answer);\n', 'typescript', monaco.Uri.parse('file:///weber/main.ts'));
  const editor = monaco.editor.create(container, { model, theme: 'vs-dark', automaticLayout: true, minimap: { enabled: false }, fontSize: 16, fontFamily: 'monospace', scrollBeyondLastLine: false });
  const results: { id: string; status: string; error?: string }[] = [];
  async function check(id: string, work: () => unknown | Promise<unknown>) {
    report({ stage: 'large-app-case-start', id });
    try { await timeout(Promise.resolve().then(work), id); results.push({ id, status: 'pass' }); }
    catch (error) { results.push({ id, status: 'fail', error: String(error) }); }
    report({ stage: 'large-app-case', ...results.at(-1) });
  }
  await check('native-webcrypto', async () => {
    const values = new Uint8Array(32); require(crypto.getRandomValues(values) === values && values.some(value => value !== 0), 'Native random fill missing');
    require(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(crypto.randomUUID()), 'UUID format differs');
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('abc'));
    require([...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('') === 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad', 'Native SHA-256 differs');
  });
  await check('actual-editor-render', async () => { await frames(); require(editor.getLayoutInfo().width > 100 && container.querySelector('.view-lines .view-line'), 'Actual Monaco view not rendered'); });
  await check('edit-undo-redo', async () => {
    const original = model.getValue(); model.pushStackElement();
    editor.executeEdits('acceptance', [{ range: model.getFullModelRange(), text: 'const changed = 7;\n' }]); model.pushStackElement();
    await model.undo(); require(model.getValue() === original, 'Undo differs');
    await model.redo(); require(model.getValue() === 'const changed = 7;\n', 'Redo differs');
  });
  await check('selection-geometry', async () => {
    editor.setSelection(new monaco.Selection(1, 1, 1, 6));
    require(model.getValueInRange(editor.getSelection()!) === 'const', 'Selection differs');
    await frames(); const position = editor.getScrolledVisiblePosition({ lineNumber: 1, column: 6 }); require(position && position.height > 0 && position.left > 0, 'Selected text geometry missing');
  });
  await check('find-widget', async () => {
    require(model.findMatches('changed', false, false, true, null, false).length === 1, 'Search matches differ');
    await editor.getAction('actions.find')!.run(); await frames(); require(container.querySelector('.find-widget'), 'Actual find widget missing'); editor.trigger('acceptance', 'closeFindWidget', null);
  });
  await check('scroll-and-resize', async () => {
    model.setValue(Array.from({ length: 500 }, (_, i) => `const line${i} = ${i};`).join('\n')); editor.revealLine(400); await frames();
    require(editor.getScrollTop() > 0 && editor.getVisibleRanges().some(range => range.startLineNumber <= 400 && range.endLineNumber >= 400), 'Editor did not scroll to line 400');
    const width = editor.getLayoutInfo().width; container.style.width = '500px'; editor.layout(); require(editor.getLayoutInfo().width === 500 && width !== 500, 'Editor did not resize'); container.style.width = '100%'; editor.layout();
  });
  await check('typescript-worker-diagnostics', async () => {
    model.setValue('const answer: number = "text";');
    const proxy = await (await typescript.getTypeScriptWorker())(model.uri);
    const diagnostics = await proxy.getSemanticDiagnostics(model.uri.toString());
    require(diagnostics.some(diagnostic => diagnostic.code === 2322), 'Actual TS worker did not report type mismatch');
    model.setValue('const answer: number = 42;');
    const corrected = await proxy.getSemanticDiagnostics(model.uri.toString()); require(!corrected.some(diagnostic => diagnostic.code === 2322), 'TS worker retained stale error');
    require(workerDiagnosticResponse, 'No diagnostic reply observed on the actual TypeScript Worker');
  });
  await check('dispose-and-recreate', async () => {
    const extra = document.createElement('div'); extra.style.cssText = 'width:400px;height:100px'; root.append(extra);
    for (let i = 0; i < 3; i++) { const temporary = monaco.editor.create(extra, { value: 'dispose test', minimap: { enabled: false } }); temporary.dispose(); }
    extra.remove(); require(monaco.editor.getModels().length === 1, 'Temporary editor models leaked'); await frames();
  });
  model.setValue('// Monaco running in Weber\nconst answer: number = 42;\n'); editor.setPosition({ lineNumber: 1, column: 1 }); editor.revealLine(1); editor.focus();
  const composition: { type: string; data: string | null; trusted: boolean; inputType?: string }[] = [];
  const inputState = () => report({ stage: 'monaco-input-state', value: model.getValue(), composition });
  const changed = model.onDidChangeContent(inputState);
  for (const type of ['compositionstart', 'compositionupdate', 'compositionend', 'input']) {
    container.addEventListener(type, event => {
      const data = event as CompositionEvent & InputEvent;
      if (type === 'input' && data.inputType !== 'insertCompositionText') return;
      composition.push({ type, data: data.data, trusted: event.isTrusted, inputType: data.inputType });
      queueMicrotask(inputState);
    });
  }
  const keys = (event: KeyboardEvent) => {
    if (event.key === 'F6') { event.preventDefault(); model.setValue(''); editor.setPosition({ lineNumber: 1, column: 1 }); editor.focus(); report({ stage: 'monaco-input-reset' }); }
    if (event.key === 'F9') { event.preventDefault(); inputState(); }
    if (event.key === 'F12') { event.preventDefault(); location.href = 'weber://close'; }
  };
  window.addEventListener('keydown', keys, true);
  report({ stage: 'monaco-auto-result', version: '0.57.0', results, origin: location.origin });
  report({ stage: 'ready', title: document.title });
  report({ stage: 'monaco-ready', value: model.getValue() });
  return () => { window.removeEventListener('keydown', keys, true); changed.dispose(); editor.dispose(); model.dispose(); workers.forEach(worker => worker.terminate()); };
}
