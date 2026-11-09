import { defineApp } from '@weber/runtime';
import profile from './profile.json';
type Context = { defer(fn: () => void): void };
const report = (data: object) => (window as any).weberHostCall(JSON.stringify({ action: 'telemetry', data }));
const require = (value: unknown, message: string) => { if (!value) throw new Error(message); };
const near = (a: number, b: number) => require(Math.abs(a - b) < 1, `${a} != ${b}`);
function box(context: Context, text: string, css = '') {
  const element = document.createElement('div');
  element.style.cssText = 'position:absolute;left:80px;top:100px;font:20px monospace;line-height:24px;width:50px;overflow-wrap:anywhere;white-space:pre-wrap;' + css;
  element.textContent = text; document.body.append(element); context.defer(() => element.remove()); return element;
}
function range(node: Node, start?: number, end?: number) {
  const result = document.createRange();
  if (start === undefined) result.selectNodeContents(node);
  else { result.setStart(node, start); result.setEnd(node, end!); }
  return [...result.getClientRects()];
}
const rows = (parts: DOMRect[]) => new Set(parts.map(part => Math.round(part.y))).size;
function contained(element: HTMLElement) {
  const bounds = element.getBoundingClientRect(), parts = range(element);
  require(parts.length > 0 && parts.every(part => part.left >= bounds.left - 1 && part.right <= bounds.right + 1), `Text overflow: ${JSON.stringify(parts.map(p => p.toJSON()))}`);
  return parts;
}
const checks: Record<string, (context: Context) => unknown> = {
  'anywhere-long-word'(context) { const element = box(context, 'abcdefghijklmnopqrst'); const parts = contained(element); require(rows(parts) >= 5, 'Long word did not wrap'); return rows(parts); },
  'break-word-long-word'(context) { const element = box(context, 'abcdefghijklmnopqrst', 'overflow-wrap:break-word'); require(rows(contained(element)) >= 5, 'break-word did not wrap'); },
  'normal-overflows'(context) { const element = box(context, 'abcdefghij', 'overflow-wrap:normal'); require(rows(range(element)) === 1 && range(element)[0].width > 50, 'normal must not break a long word'); },
  'nowrap-overflows'(context) { const element = box(context, 'abcdefghij', 'white-space:nowrap'); require(rows(range(element)) === 1 && range(element)[0].width > 50, 'nowrap must suppress emergency wrapping'); },
  'fitting-words-stay-whole'(context) {
    const element = box(context, 'ab cde', 'white-space:normal;width:60px;'), text = element.firstChild!;
    const first = range(text, 0, 2), word = range(text, 3, 6); require(rows(word) === 1, 'Fitting word was split'); require(word[0].y > first[0].y, 'Word should move to the next line'); near(word.reduce((n, p) => n + p.width, 0), 36);
  },
  'combining-clusters'(context) {
    const element = box(context, 'A\u0301'.repeat(8), 'width:18px'), text = element.firstChild!; require(rows(range(element)) >= 4, 'Combining text did not wrap');
    for (let i = 0; i < 16; i += 2) { const parts = range(text, i, i + 2); require(rows(parts) === 1, 'Combining cluster split across lines'); near(parts[0].width, 12); }
  },
  'emoji-zwj-clusters'(context) {
    const cluster = '👩‍👩‍👧‍👦', element = box(context, cluster.repeat(4), 'width:70px'), text = element.firstChild!;
    for (let i = 0; i < 4; i++) require(rows(range(text, i * cluster.length, (i + 1) * cluster.length)) === 1, 'ZWJ cluster split'); require(rows(range(element)) > 1, 'Emoji text did not wrap');
  },
  'rtl-long-word'(context) { const element = box(context, 'אבגדהוזחטיכלמנסעפצקרשת', 'direction:rtl'); require(rows(contained(element)) >= 3, 'RTL word did not wrap'); },
  'nested-inline-word'(context) { const element = box(context, ''); element.innerHTML = '<span>abcd</span><span>efgh</span><span>ijkl</span>'; require(rows(contained(element)) >= 3, 'Word across spans did not wrap'); },
  'anywhere-min-content'(context) {
    const element = box(context, 'abcdefghij', 'width:min-content'); require(element.getBoundingClientRect().width <= 13, 'anywhere did not reduce min-content');
  },
  'break-word-min-content'(context) {
    const normal = box(context, 'abcdefghij', 'width:min-content;overflow-wrap:normal'), emergency = box(context, 'abcdefghij', 'width:min-content;overflow-wrap:break-word');
    near(normal.getBoundingClientRect().width, emergency.getBoundingClientRect().width); require(normal.getBoundingClientRect().width >= 119, 'break-word changed intrinsic width');
  },
  'zero-width-container'(context) { const element = box(context, 'abcd', 'width:0'); const count = rows(range(element)); require(count >= 4 && count <= 5, `No progress at zero width: ${count}`); },
  'resize-reflow'(context) { const element = box(context, 'abcdefghij'); require(rows(range(element)) >= 3, 'Initial wrap missing'); element.style.width = '200px'; require(rows(range(element)) === 1, 'Resize left stale line breaks'); element.style.width = '50px'; require(rows(contained(element)) >= 3, 'Wrap missing after resize'); },
};
defineApp({ title: 'Weber overflow wrapping acceptance', mount(root) {
  root.textContent = 'Checking actual text layout';
  void (async () => {
    report({ stage: 'ready' }); const results = [];
    for (const id of profile.required) {
      const cleanup: (() => void)[] = []; report({ stage: 'large-app-case-start', id });
      try { const geometry = checks[id]({ defer: fn => cleanup.push(fn) }); results.push({ id, status: 'pass', geometry: geometry ?? null }); }
      catch (error) { results.push({ id, status: 'fail', error: String(error) }); }
      finally { for (const remove of cleanup.reverse()) remove(); }
      report({ stage: 'large-app-case', ...results.at(-1) });
    }
    report({ stage: 'large-app-result', profile: profile.id, href: location.href, origin: location.origin, results });
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); location.href = 'weber://close';
  })();
} });
