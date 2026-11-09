import { defineApp } from '@weber/runtime';
import profile from './profile.json';
type Context = { defer(fn: () => void): void };
const report = (data: object) => (window as any).weberHostCall(JSON.stringify({ action: 'telemetry', data }));
const require = (value: unknown, message: string) => { if (!value) throw new Error(message); };
const near = (a: number, b: number, label: string) => require(Math.abs(a - b) < 1, `${label}: ${a} != ${b}`);
const rect = (r: DOMRect) => ({ x: r.x, y: r.y, width: r.width, height: r.height });
function box(context: Context, text: string, css = '') {
  const element = document.createElement('div');
  element.style.cssText = 'position:absolute;left:80px;top:100px;margin:0;padding:0;border:0;font:20px monospace;line-height:24px;width:240px;white-space:pre;' + css;
  element.textContent = text; document.body.append(element); context.defer(() => element.remove()); return element;
}
function select(node: Node, start: number, end: number) { const range = document.createRange(); range.setStart(node, start); range.setEnd(node, end); return range; }
const frames = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
const checks: Record<string, (context: Context) => unknown | Promise<unknown>> = {
  'partial-text'(context) {
    const element = box(context, 'abcdefgh'), text = element.firstChild!;
    const whole = select(text, 0, 8).getBoundingClientRect(), part = select(text, 2, 4).getBoundingClientRect();
    require(whole.width > 0 && part.height > 0, 'Missing text geometry');
    near(part.width, whole.width / 4, 'partial advance'); near(part.x, whole.x + whole.width / 4, 'partial origin');
    return { whole: rect(whole), part: rect(part) };
  },
  'collapsed-caret'(context) {
    const element = box(context, 'abcd'), text = element.firstChild!, whole = select(text, 0, 4).getBoundingClientRect();
    const caret = select(text, 2, 2).getBoundingClientRect();
    require(caret.width === 0 && caret.height > 0, 'Collapsed text caret must retain position and height');
    near(caret.x, whole.x + whole.width / 2, 'caret origin'); return rect(caret);
  },
  'surrogate-boundaries'(context) {
    const element = box(context, 'A😀B'), text = element.firstChild!, full = select(text, 1, 3).getBoundingClientRect();
    require(full.width > 0 && full.height > 0, 'Emoji geometry missing');
    for (const [start, end] of [[1, 2], [2, 3], [2, 2]]) {
      const part = select(text, start, end).getBoundingClientRect(); near(part.x, full.x, 'surrogate origin'); near(part.width, full.width, 'surrogate unit width');
    }
    return rect(full);
  },
  'combining-cluster'(context) {
    const element = box(context, 'A\u0301B'), text = element.firstChild!, full = select(text, 0, 2).getBoundingClientRect(), mark = select(text, 1, 2).getBoundingClientRect();
    require(full.width > 0, 'Combining cluster missing'); near(mark.x, full.x, 'cluster origin'); near(mark.width, full.width, 'cluster width'); return rect(mark);
  },
  'normal-wrapped-lines'(context) {
    const element = box(context, 'ab cd ef gh ij', 'width:50px;white-space:normal;');
    const range = select(element.firstChild!, 0, 14), parts = [...range.getClientRects()], whole = range.getBoundingClientRect();
    require(new Set(parts.map(part => Math.round(part.y))).size >= 3, `Missing normal wrapped fragments: ${JSON.stringify(parts.map(rect))}`);
    require(element.getBoundingClientRect().height >= 72, 'Text was not laid out on multiple lines');
    near(whole.bottom, Math.max(...parts.map(part => part.bottom)), 'normal multiline bottom'); return parts.map(rect);
  },
  'wrapped-lines'(context) {
    const element = box(context, 'abcdefghij', 'width:50px;white-space:pre-wrap;overflow-wrap:anywhere;'), range = select(element.firstChild!, 0, 10);
    const parts = [...range.getClientRects()], whole = range.getBoundingClientRect();
    require(new Set(parts.map(part => Math.round(part.y))).size >= 3, `Missing wrapped line fragments: ${JSON.stringify({parts:parts.map(rect),element:element.getBoundingClientRect().toJSON(),whiteSpace:getComputedStyle(element).whiteSpace,overflowWrap:getComputedStyle(element).overflowWrap})}`);
    near(whole.y, Math.min(...parts.map(part => part.y)), 'multiline top');
    near(whole.bottom, Math.max(...parts.map(part => part.bottom)), 'multiline bottom'); return parts.map(rect);
  },
  'rtl-logical-offsets'(context) {
    const element = box(context, 'אבגד', 'direction:rtl;'), text = element.firstChild!;
    const first = select(text, 0, 1).getBoundingClientRect(), second = select(text, 1, 2).getBoundingClientRect();
    require(first.width > 0 && second.width > 0 && first.x > second.x, `RTL logical order incorrect: ${JSON.stringify([rect(first), rect(second)])}`);
    return [rect(first), rect(second)];
  },
  'nested-text'(context) {
    const element = box(context, ''); element.innerHTML = '<span>abc</span><span>def</span>';
    const range = document.createRange(); range.setStart(element.children[0].firstChild!, 1); range.setEnd(element.children[1].firstChild!, 2);
    const parts = [...range.getClientRects()]; require(parts.length === 2 && parts.every(part => part.width > 0), `Wrong nested fragments: ${JSON.stringify(parts.map(rect))}`);
    const full = select(element.children[0].firstChild!, 0, 3).getBoundingClientRect(); near(parts[0].width, full.width * 2 / 3, 'first partial node'); near(parts[1].width, full.width * 2 / 3, 'last partial node');
    return parts.map(rect);
  },
  'element-boundaries'(context) {
    const element = box(context, ''); element.innerHTML = '<span>ab</span><span>cd</span>';
    const selected = select(element, 1, 2).getBoundingClientRect(), child = element.children[1].getBoundingClientRect();
    require(selected.width > 0 && selected.x >= child.x - 1, `Unselected sibling leaked into range: ${JSON.stringify(rect(selected))}`); near(selected.right, child.right, 'element boundary right'); return rect(selected);
  },
  'disconnected-hidden'(context) {
    const element = box(context, 'abcd'), range = select(element.firstChild!, 0, 4); require(range.getBoundingClientRect().width > 0, 'Visible text missing');
    element.style.display = 'none'; require(range.getClientRects().length === 0, 'display:none text has rectangles');
    element.style.display = ''; element.remove(); require(range.getClientRects().length === 0, 'Detached text has rectangles');
  },
  'transformed-text'(context) {
    const element = box(context, 'abcd'), range = select(element.firstChild!, 1, 3), before = range.getBoundingClientRect();
    element.style.transformOrigin = '0 0'; element.style.transform = 'translate(40px, 30px) scale(1.5)';
    const after = range.getBoundingClientRect(); require(before.width > 0, 'Original text missing');
    near(after.x, 80 + 40 + (before.x - 80) * 1.5, 'transformed x'); near(after.width, before.width * 1.5, 'transformed width'); near(after.y, 100 + 30 + (before.y - 100) * 1.5, 'transformed y');
    return { before: rect(before), after: rect(after) };
  },
  async 'scrolled-text'(context) {
    const element = box(context, '', 'width:120px;height:30px;overflow:auto;');
    const content = document.createElement('div'); content.style.cssText = 'width:600px;height:200px;white-space:pre'; content.textContent = 'abcdefghijklmnopqrstuvwxyz'; element.append(content);
    const range = select(content.firstChild!, 5, 7), before = range.getBoundingClientRect(); element.scrollLeft = 20; element.scrollTop = 10; await frames();
    const after = range.getBoundingClientRect(); near(after.x, before.x - element.scrollLeft, 'scroll x'); near(after.y, before.y - element.scrollTop, 'scroll y'); near(after.width, before.width, 'scroll width'); return { before: rect(before), after: rect(after) };
  },
  'collapsed-whitespace'(context) {
    const element = box(context, 'ab   cd', 'white-space:normal;'), text = element.firstChild!;
    const first = select(text, 0, 2).getBoundingClientRect(), last = select(text, 5, 7).getBoundingClientRect();
    require(first.width > 0 && last.width > 0, 'Whitespace-mapped text missing'); near(last.x, first.x + first.width * 1.5, 'collapsed white-space offset'); near(last.width, first.width, 'mapped advance'); return [rect(first), rect(last)];
  },
};
defineApp({ title: 'Weber Range geometry acceptance', mount(root) {
  root.innerHTML = '<h1>Native text Range geometry</h1><pre id="results"></pre>';
  let disposed = false;
  void (async () => {
    report({ stage: 'ready', title: document.title }); const results = [];
    for (const id of profile.required) {
      const cleanup: (() => void)[] = []; report({ stage: 'large-app-case-start', id });
      try { const geometry = await checks[id]({ defer: fn => cleanup.push(fn) }); results.push({ id, status: 'pass', geometry: geometry ?? null }); }
      catch (error) { results.push({ id, status: 'fail', error: String(error) }); }
      finally { for (const release of cleanup.reverse()) release(); }
      if (disposed) return; report({ stage: 'large-app-case', ...results.at(-1) }); root.querySelector('#results')!.textContent = JSON.stringify(results, null, 2);
    }
    report({ stage: 'large-app-result', profile: profile.id, href: location.href, origin: location.origin, results });
    await frames(); if (!disposed) location.href = 'weber://close';
  })().catch(error => report({ stage: 'failure', message: String(error) }));
  return () => { disposed = true; };
} });
