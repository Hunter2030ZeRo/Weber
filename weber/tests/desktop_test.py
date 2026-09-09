"""Real X11 -> GTK -> Obscura input, presentation and separate documents."""
import json
import os
from pathlib import Path
import queue
import subprocess
import sys
import tempfile
import threading
import time

host, renderer = map(lambda value: str(Path(value).resolve()), sys.argv[1:])
process = subprocess.Popen([host, renderer], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, bufsize=1)
messages = queue.Queue()
def read():
    for line in process.stdout:
        messages.put(json.loads(line))
    messages.put({'event': 'eof'})
threading.Thread(target=read, daemon=True).start()
events = []
sequence = 0
def request(method, **fields):
    global sequence
    sequence += 1
    process.stdin.write(json.dumps(dict(id=sequence, method=method, **fields)) + '\n')
    process.stdin.flush()
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline:
        value = messages.get(timeout=max(0.1, deadline-time.monotonic()))
        if value.get('id') == sequence:
            if 'error' in value:
                raise AssertionError(value['error'])
            return value['result']
        assert value.get('event') not in ('eof', 'frame-error', 'render-process-gone'), value
        events.append(value)
    raise AssertionError('Host request deadline')
def command(window, method, **fields):
    return request('page.command', windowId=window, command=dict(method=method, **fields))
def evaluate(window, source):
    return command(window, 'evaluate', source=source)
try:
    with tempfile.TemporaryDirectory() as directory:
        page = Path(directory) / 'page.html'
        page.write_text('''<!doctype html><html><body style="margin:0;background:#fff">
<button id="click" style="position:absolute;left:20px;top:20px;width:160px;height:60px" onclick="this.textContent='clicked'">click</button>
<input id="text" style="position:absolute;left:20px;top:110px;width:250px;height:50px">
</body></html>''')
        first = request('window.create', windowId=1, options=dict(width=640, height=480, title='Weber Test A'))
        second = request('window.create', windowId=2, options=dict(width=640, height=480, title='Weber Test B'))
        assert first['rendererPid'] != second['rendererPid']
        for window in (1, 2):
            command(window, 'loadFile', path=str(page))
        assert evaluate(1, 'Promise.resolve(6 * 7)') == 42
        xwindow = subprocess.check_output(['xdotool', 'search', '--name', '^Weber Test A$'], text=True).splitlines()[-1]
        subprocess.run(['xdotool', 'windowraise', xwindow], check=True)
        subprocess.run(['xdotool', 'windowfocus', '--sync', xwindow], check=True)
        subprocess.run(['xdotool', 'mousemove', '--sync', '--window', xwindow, '60', '40', 'click', '1'], check=True)
        deadline = time.monotonic() + 10
        while evaluate(1, 'document.getElementById("click").textContent') != 'clicked':
            assert time.monotonic() < deadline, 'Real X11 click did not reach Obscura'
            time.sleep(.05)
        assert evaluate(2, 'document.getElementById("click").textContent') == 'click'
        subprocess.run(['xdotool', 'mousemove', '--sync', '--window', xwindow, '70', '130', 'click', '1'], check=True)
        subprocess.run(['xdotool', 'type', '--clearmodifiers', '--delay', '30', 'weber'], check=True)
        deadline = time.monotonic() + 10
        while evaluate(1, 'document.getElementById("text").value') != 'weber':
            assert time.monotonic() < deadline, 'Real X11 keyboard input did not reach Obscura'
            time.sleep(.05)
        capture = command(1, 'capturePng')
        assert capture['encoding'] == 'base64' and len(capture['data']) > 100
        assert any(item.get('event') == 'frame-presented' and item.get('windowId') == 1 for item in events), 'GTK did not paint Obscura frame'
        for data in (first, second):
            actual = Path(f'/proc/{data["rendererPid"]}/exe').resolve().name
            assert actual == 'weber-obscura-renderer', actual
        request('window.close', windowId=1)
        assert evaluate(2, '21 * 2') == 42
        request('window.close', windowId=2)
        request('app.quit')
        assert process.wait(timeout=10) == 0
        print('PASS: two real windows, raw frame presentation, X11 mouse/keyboard, Promise, isolated documents, capture and close')
finally:
    if process.poll() is None:
        process.stdin.close()
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()
