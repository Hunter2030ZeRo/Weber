import * as monaco from 'monaco-editor/esm/vs/editor/editor.api.js';
monacoProbe.stage = 'module';
try {
  const editor = monaco.editor.create(document.getElementById('editor'), {
    value: 'const answer = 42;\n', language: 'plaintext', automaticLayout: false,
    minimap: { enabled: false }, fontSize: 16,
  });
  globalThis.probeEditor = editor;
  monacoProbe.stage = 'editor';
  editor.layout({ width: 800, height: 600 });
  editor.focus();
  globalThis.probeStartDiff = () => {
    const container = document.createElement('div');
    container.style.cssText = 'position:absolute;inset:0;width:800px;height:600px;background:white';
    document.body.appendChild(container);
    const diff = monaco.editor.createDiffEditor(container, { automaticLayout: false, renderSideBySide: true,
      originalEditable: false, minimap: { enabled: false } });
    globalThis.probeDiff = diff;
    diff.setModel({ original: monaco.editor.createModel('one\ntwo\n', 'plaintext'),
      modified: monaco.editor.createModel('one\nchanged\n', 'plaintext') });
    diff.layout({ width: 800, height: 600 });
    return true;
  };
} catch (error) {
  monacoProbe.errors.push(String(error.stack || error));
}
