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
} catch (error) {
  monacoProbe.errors.push(String(error.stack || error));
}
