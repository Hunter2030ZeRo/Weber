(() => {
  let downTarget = null;
  function insert(text, backspace = false) {
    const target = document.activeElement;
    if (!target || !['input', 'textarea'].includes(target.localName) || target.disabled || target.readOnly) return;
    const value = target.value || '';
    let start = target.selectionStart ?? value.length;
    let end = target.selectionEnd ?? start;
    if (backspace && start === end && start) {
      start -= Array.from(value.slice(0, start)).at(-1).length;
    }
    const event = new Event('beforeinput', { bubbles: true, cancelable: true });
    if (!target.dispatchEvent(event)) return;
    const updated = value.slice(0, start) + text + value.slice(end);
    if (globalThis.__obscura_setFieldValue) globalThis.__obscura_setFieldValue(target, 'value', updated);
    else target.value = updated;
    try { target.setSelectionRange(start + text.length, start + text.length); } catch {}
    target.dispatchEvent(new Event('input', { bubbles: true }));
  }
  Object.defineProperty(globalThis, '__weberInput', { value: input => {
    if (input.type === 'text') { insert(input.text); return; }
    if (input.type === 'key') {
      const target = document.activeElement || document.body;
      if (!target) return;
      const allowed = target.dispatchEvent(new KeyboardEvent(input.pressed ? 'keydown' : 'keyup', {
        key: input.key, bubbles: true, cancelable: true
      }));
      if (allowed && input.pressed && input.key === 'Backspace') insert('', true);
      return;
    }
    const target = document.elementFromPoint(input.x, input.y) || document.body;
    if (!target) return;
    if (input.type === 'wheel') {
      const event = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaX: input.dx, deltaY: input.dy });
      if (target.dispatchEvent(event)) globalThis.scrollBy(input.dx, input.dy);
      return;
    }
    const kind = input.type === 'down' ? 'mousedown' : input.type === 'up' ? 'mouseup' : 'mousemove';
    const allowed = target.dispatchEvent(new MouseEvent(kind, {
      clientX: input.x, clientY: input.y, button: 0, bubbles: true, cancelable: true
    }));
    if (input.type === 'down') {
      downTarget = allowed ? target : null;
      if (allowed && typeof target.focus === 'function') target.focus();
    }
    if (input.type === 'up') {
      if (allowed && target === downTarget && typeof target.click === 'function') target.click();
      downTarget = null;
    }
  } });
})();
