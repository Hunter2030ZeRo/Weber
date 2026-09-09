// SPDX-License-Identifier: Apache-2.0
//! Desktop transport for the retained Obscura renderer.
//!
//! Input routines adapt obscura-cdp/src/domains/input.rs at
//! 727cc46d56290995245fbe790caed52fc699452a (Apache-2.0).
//! Weber changes: validated request fields, bounded execution, mousedown
//! focus, mouse movement, key modifiers, and cancelled key default actions.
//! This uses Obscura's existing JS event-dispatch implementation. It does not
//! claim OS IME composition, pointer capture, touch, or full browser input parity.

use obscura_browser::Page;
use serde_json::{json, Value};
use std::time::Duration;

const FRAME_HEADER: usize = 12;
const MAX_FRAME_BYTES: usize = 64 * 1024 * 1024;
const MAX_INPUT_TEXT: usize = 64 * 1024;

pub(crate) fn dispatch(page: &mut Page, request: &Value) -> Option<Result<Vec<u8>, String>> {
    match request.get("method").and_then(Value::as_str)? {
        "captureFrame" => Some(capture_frame(page, false)),
        "captureFrameIfChanged" => Some(capture_frame(page, true)),
        "dispatchMouseEvent" => Some(dispatch_mouse(page, request)),
        "dispatchKeyEvent" => Some(dispatch_key(page, request)),
        "insertText" => Some((|| {
            let text = required_string(request, "text", MAX_INPUT_TEXT)?;
            execute(page, &insert_text_js(text))
        })()),
        _ => None,
    }
}

// OBF1 | width:u32LE | height:u32LE | tightly packed premultiplied RGBA8.
// Raster size follows Page.viewport in CSS pixels, scale 1.
fn capture_frame(page: &Page, only_if_changed: bool) -> Result<Vec<u8>, String> {
    let (width, height) = page.viewport;
    if width < 1.0 || height < 1.0 || !width.is_finite() || !height.is_finite()
        || width * height > ((MAX_FRAME_BYTES - FRAME_HEADER) / 4) as f32 {
        return Err("Frame exceeds transport bounds".into());
    }
    let frame = if only_if_changed {
        page.render_frame_rgba_if_changed()?
    } else {
        Some(page.render_frame_rgba().ok_or("Rendering failed")?)
    };
    let Some((width, height, mut rgba)) = frame else {
        return Ok(Vec::new());
    };
    let expected = (width as usize).checked_mul(height as usize)
        .and_then(|pixels| pixels.checked_mul(4)).ok_or("Frame size overflow")?;
    if rgba.len() != expected || expected > MAX_FRAME_BYTES - FRAME_HEADER {
        return Err("Invalid frame dimensions".into());
    }
    // The pixmap already owns these bytes. Insert a small header into that
    // allocation instead of constructing an additional full-size frame buffer.
    rgba.reserve(FRAME_HEADER);
    rgba.resize(expected + FRAME_HEADER, 0);
    rgba.copy_within(0..expected, FRAME_HEADER);
    rgba[..4].copy_from_slice(b"OBF1");
    rgba[4..8].copy_from_slice(&width.to_le_bytes());
    rgba[8..12].copy_from_slice(&height.to_le_bytes());
    Ok(rgba)
}

fn required_string<'a>(request: &'a Value, field: &str, max: usize) -> Result<&'a str, String> {
    let text = request.get(field).and_then(Value::as_str)
        .ok_or_else(|| format!("Missing or invalid {field}"))?;
    if text.len() > max { return Err(format!("{field} exceeds input bounds")); }
    Ok(text)
}

fn finite_number(request: &Value, field: &str) -> Result<f64, String> {
    let number = request.get(field).and_then(Value::as_f64)
        .ok_or_else(|| format!("Missing or invalid {field}"))?;
    if !number.is_finite() || number.abs() > 10_000_000.0 {
        return Err(format!("{field} exceeds input bounds"));
    }
    Ok(number)
}

fn bounded_integer(request: &Value, field: &str, default: u64, max: u64) -> Result<u64, String> {
    let number = match request.get(field) {
        None => default,
        Some(value) => value.as_u64().ok_or_else(|| format!("Invalid {field}"))?,
    };
    if number > max { return Err(format!("{field} exceeds input bounds")); }
    Ok(number)
}

fn execute(page: &mut Page, source: &str) -> Result<Vec<u8>, String> {
    if page.js.is_none() { return Err("No document loaded".into()); }
    let source = format!("(() => {{ try {{ {source}; return {{ok:true}}; }} catch(e) {{ return {{ok:false,error:String(e)}}; }} }})()");
    let result = page.evaluate_with_timeout(&source, Duration::from_secs(2));
    if result.get("ok").and_then(Value::as_bool) != Some(true) {
        return Err(result.get("error").and_then(Value::as_str)
            .unwrap_or("Input dispatch failed or timed out").into());
    }
    Ok(b"null".to_vec())
}

fn js_str(s: &str) -> String {
    serde_json::to_string(s).unwrap_or_else(|_| "\"\"".to_string())
}

// Insert `text` at the caret, replacing any non-collapsed selection the way a
// real browser does when you type over selected text (for example after a
// triple-click select-all). selectionStart is null during ordinary typing, so
// the legacy append path is kept when no selection is tracked.
//
// The text is embedded as a JSON string literal rather than escaped by hand
// into single quotes. JSON string syntax is a subset of JavaScript's, so this
// covers the quote and the backslash of issue #433 and the control characters
// they left out: a newline inside a single-quoted literal is a syntax error,
// so the whole snippet was dropped and nothing was inserted. obscura-mcp
// already builds its typing snippet this way.
fn insert_text_js(text: &str) -> String {
    let literal = serde_json::to_string(text).unwrap_or_else(|_| "\"\"".to_string());
    format!(
        "(function() {{\
            var t = document.activeElement;\
            if (!t || (t.localName !== 'input' && t.localName !== 'textarea')) return;\
            var ins = {text};\
            var v = t.value || '';\
            var s = t.selectionStart, e = t.selectionEnd;\
            if (s == null) {{\
                globalThis.__obscura_setFieldValue(t, 'value', v + ins);\
            }} else {{\
                s = Math.max(0, Math.min(s, v.length));\
                e = (e == null) ? s : Math.max(0, Math.min(e, v.length));\
                var lo = Math.min(s, e), hi = Math.max(s, e);\
                globalThis.__obscura_setFieldValue(t, 'value', v.slice(0, lo) + ins + v.slice(hi));\
                var caret = lo + ins.length;\
                t.setSelectionRange(caret, caret);\
            }}\
            t.dispatchEvent(globalThis.__obscura_markTrusted(new Event('input', {{bubbles:true}})));\
        }})()",
        text = literal,
    )
}

// Backspace deletes the selected range when there is one, so the common
// "triple-click to select-all, then Backspace to clear" pattern works. With a
// collapsed caret it removes the character before the caret, and with no
// selection tracked it falls back to trimming the last character (legacy).
const BACKSPACE_JS: &str = "(function() {\
    var t = document.activeElement;\
    if (!t || (t.localName !== 'input' && t.localName !== 'textarea')) return;\
    var v = t.value || '';\
    var s = t.selectionStart, e = t.selectionEnd;\
    if (s == null) {\
        globalThis.__obscura_setFieldValue(t, 'value', v.slice(0, -1));\
    } else {\
        s = Math.max(0, Math.min(s, v.length));\
        e = (e == null) ? s : Math.max(0, Math.min(e, v.length));\
        if (s !== e) {\
            var lo = Math.min(s, e), hi = Math.max(s, e);\
            globalThis.__obscura_setFieldValue(t, 'value', v.slice(0, lo) + v.slice(hi));\
            t.setSelectionRange(lo, lo);\
        } else if (s > 0) {\
            globalThis.__obscura_setFieldValue(t, 'value', v.slice(0, s - 1) + v.slice(s));\
            t.setSelectionRange(s - 1, s - 1);\
        }\
    }\
    t.dispatchEvent(globalThis.__obscura_markTrusted(new Event('input', {bubbles:true})));\
})()";

fn mouse_button_code(button: &str) -> u8 {
    match button {
        "middle" => 1,
        "right" => 2,
        "back" => 3,
        "forward" => 4,
        _ => 0,
    }
}

fn mouse_button_mask(button: &str) -> u64 {
    match button {
        "right" => 2,
        "middle" => 4,
        "back" => 8,
        "forward" => 16,
        "none" => 0,
        _ => 1,
    }
}

fn modifier_flags(modifiers: u64) -> (bool, bool, bool, bool) {
    // CDP Input.Modifier: Alt=1, Ctrl=2, Meta=4, Shift=8.
    (
        modifiers & 1 != 0,
        modifiers & 2 != 0,
        modifiers & 4 != 0,
        modifiers & 8 != 0,
    )
}

fn dispatch_mouse(page: &mut Page, params: &Value) -> Result<Vec<u8>, String> {
    let event_type = required_string(params, "type", 32)?;
    let x = finite_number(params, "x")?;
    let y = finite_number(params, "y")?;
    let button = params.get("button").and_then(Value::as_str).unwrap_or("none");
    if !matches!(button, "left" | "middle" | "right" | "back" | "forward" | "none") {
        return Err("Unsupported mouse button".into());
    }
    let button_code = mouse_button_code(button);
    let default_buttons = if event_type == "mousePressed" { mouse_button_mask(button) } else { 0 };
    let buttons = bounded_integer(params, "buttons", default_buttons, 31)?;
    let click_count = bounded_integer(params, "clickCount", 1, 3)?;
    let modifiers = bounded_integer(params, "modifiers", 0, 15)?;
    let (alt_key, ctrl_key, meta_key, shift_key) = modifier_flags(modifiers);
    match event_type {
        "mousePressed" => {
            if button == "none" { return Err("mousePressed requires a button".into()); }
            let code = format!(
                        "(function() {{\
                            var target = (document.elementFromPoint && document.elementFromPoint({x},{y})) || globalThis.__obscura_click_target || document.activeElement || document.body;\
                            if (!target) return;\
                            globalThis.__obscura_click_target = target;\
                            globalThis.__obscura_mouse_down = {{target:target,button:{button_code},clickCount:{click_count}}};\
                            var evt = globalThis.__obscura_markTrusted(new MouseEvent('mousedown', {{bubbles:true,cancelable:true,view:globalThis,clientX:{x},clientY:{y},button:{button_code},buttons:{buttons},detail:{click_count},altKey:{alt_key},ctrlKey:{ctrl_key},metaKey:{meta_key},shiftKey:{shift_key}}}));\
                            if (target.dispatchEvent(evt) && typeof target.focus === 'function') target.focus();\
                        }})()",
                        x = x,
                        y = y,
                        button_code = button_code,
                        buttons = buttons,
                        click_count = click_count,
                        alt_key = alt_key,
                        ctrl_key = ctrl_key,
                        meta_key = meta_key,
                        shift_key = shift_key,
                    );
            execute(page, &code)
        }
        "mouseReleased" => {
            if button == "none" { return Err("mouseReleased requires a button".into()); }
            let code = format!(
                        "(function() {{\
                            var target = (document.elementFromPoint && document.elementFromPoint({x},{y})) || globalThis.__obscura_click_target || document.activeElement || document.body;\
                            if (!target) return;\
                            var down = globalThis.__obscura_mouse_down;\
                            globalThis.__obscura_mouse_down = null;\
                            var evt = globalThis.__obscura_markTrusted(new MouseEvent('mouseup', {{bubbles:true,cancelable:true,view:globalThis,clientX:{x},clientY:{y},button:{button_code},buttons:0,detail:{click_count},altKey:{alt_key},ctrlKey:{ctrl_key},metaKey:{meta_key},shiftKey:{shift_key}}}));\
                            target.dispatchEvent(evt);\
                            if (!down || down.button !== {button_code} || {button_code} !== 0) return;\
                            var clickTarget = down.target;\
                            while (clickTarget && clickTarget !== target && !(clickTarget.contains && clickTarget.contains(target))) {{\
                                clickTarget = clickTarget.parentElement;\
                            }}\
                            if (!clickTarget) return;\
                            var tag = clickTarget.tagName;\
                            var type = (clickTarget.getAttribute && clickTarget.getAttribute('type') || '').toLowerCase();\
                            if (globalThis.__obscura_isDisabled(clickTarget)) return;\
                            var checkable = tag === 'INPUT' && (type === 'checkbox' || type === 'radio');\
                            var oldChecked = checkable ? !!clickTarget.checked : false;\
                            var oldIndeterminate = checkable ? !!clickTarget.indeterminate : false;\
                            var radioStates = null;\
                            if (checkable && type === 'radio') {{\
                                var radioName = clickTarget.getAttribute('name') || '';\
                                if (radioName) {{\
                                    var candidates = document.querySelectorAll('input');\
                                    radioStates = [];\
                                    for (var ri = 0; ri < candidates.length; ri++) {{\
                                        var radio = candidates[ri];\
                                        if ((radio.getAttribute('type') || '').toLowerCase() !== 'radio' || (radio.getAttribute('name') || '') !== radioName || radio.form !== clickTarget.form) continue;\
                                        radioStates.push([radio, !!radio.checked]);\
                                        if (radio !== clickTarget) radio.checked = false;\
                                    }}\
                                }}\
                                clickTarget.checked = true;\
                            }} else if (checkable) {{\
                                clickTarget.checked = !oldChecked;\
                                clickTarget.indeterminate = false;\
                            }}\
                            var click = globalThis.__obscura_markTrusted(new MouseEvent('click', {{bubbles:true,cancelable:true,view:globalThis,clientX:{x},clientY:{y},button:0,buttons:0,detail:{click_count},altKey:{alt_key},ctrlKey:{ctrl_key},metaKey:{meta_key},shiftKey:{shift_key}}}));\
                            var cancelled = !clickTarget.dispatchEvent(click);\
                            if (cancelled) {{\
                                if (radioStates) {{\
                                    for (var rr = 0; rr < radioStates.length; rr++) radioStates[rr][0].checked = radioStates[rr][1];\
                                }} else if (checkable) {{ clickTarget.checked = oldChecked; clickTarget.indeterminate = oldIndeterminate; }}\
                                return;\
                            }}\
                            if (checkable && clickTarget.checked !== oldChecked) {{\
                                try {{ clickTarget.dispatchEvent(globalThis.__obscura_markTrusted(new Event('input', {{bubbles:true}}))); }} catch(e) {{}}\
                                try {{ clickTarget.dispatchEvent(globalThis.__obscura_markTrusted(new Event('change', {{bubbles:true}}))); }} catch(e) {{}}\
                                return;\
                            }}\
                            var labelHost = tag === 'LABEL' ? clickTarget : (clickTarget.closest ? clickTarget.closest('label') : null);\
                            var interactiveHost = globalThis.__obscura_interactiveHost(clickTarget);\
                            if (labelHost && !(interactiveHost && labelHost.contains(interactiveHost))) {{\
                                var ctl = globalThis.__obscura_labeledControl(labelHost);\
                                if (ctl && ctl !== clickTarget && globalThis.__obscura_activateLabel(labelHost, ctl, true)) {{ return; }}\
                            }}\
                            var link = clickTarget.closest ? clickTarget.closest('a[href]') : null;\
                            if (!link && tag === 'A' && clickTarget.getAttribute('href')) link = clickTarget;\
                            if (link) {{\
                                var href = link.getAttribute('href');\
                                if (href && !href.startsWith('#') && !href.startsWith('javascript:')) location.assign(href);\
                            }} else if (tag === 'BUTTON' && type !== 'button' && type !== 'reset') {{\
                                var form = clickTarget.closest ? clickTarget.closest('form') : null;\
                                if (form) {{ try {{ if (typeof form.requestSubmit === 'function') {{ form.requestSubmit(clickTarget); }} else {{ form.submit(clickTarget); }} }} catch(e) {{}} }}\
                            }} else if (tag === 'INPUT' && (type === 'submit' || type === 'image')) {{\
                                var form2 = clickTarget.closest ? clickTarget.closest('form') : null;\
                                if (form2) {{ try {{ if (typeof form2.requestSubmit === 'function') {{ form2.requestSubmit(clickTarget); }} else {{ form2.submit(clickTarget); }} }} catch(e) {{}} }}\
                            }} else if ({click_count} >= 3 && (tag === 'INPUT' || tag === 'TEXTAREA')) {{\
                                var len = clickTarget.value ? clickTarget.value.length : 0;\
                                if (clickTarget.setSelectionRange) clickTarget.setSelectionRange(0, len);\
                                else {{ clickTarget.selectionStart = 0; clickTarget.selectionEnd = len; }}\
                            }}\
                        }})()",
                        x = x,
                        y = y,
                        button_code = button_code,
                        click_count = click_count,
                        alt_key = alt_key,
                        ctrl_key = ctrl_key,
                        meta_key = meta_key,
                        shift_key = shift_key,
                    );
            execute(page, &code)
        }
        "mouseWheel" => {
            let delta_x = finite_number(params, "deltaX")?;
            let delta_y = finite_number(params, "deltaY")?;
            let code = format!(
                        "(function() {{\
                            var target = (document.elementFromPoint && document.elementFromPoint({x},{y})) || document.body || document.documentElement;\
                            if (!target) return;\
                            var wheel = globalThis.__obscura_markTrusted(new WheelEvent('wheel', {{bubbles:true,cancelable:true,view:globalThis,clientX:{x},clientY:{y},deltaX:{delta_x},deltaY:{delta_y},deltaMode:0,altKey:{alt_key},ctrlKey:{ctrl_key},metaKey:{meta_key},shiftKey:{shift_key}}}));\
                            if (!target.dispatchEvent(wheel)) return;\
                            var dx = {delta_x}, dy = {delta_y};\
                            var root = document.scrollingElement || document.documentElement || document.body;\
                            var scrollTarget = null;\
                            var el = target;\
                            while (el && el.nodeType === 1 && el !== root && el !== document.body && el !== document.documentElement) {{\
                                var maxX = Math.max(0, (el.scrollWidth || 0) - (el.clientWidth || 0));\
                                var maxY = Math.max(0, (el.scrollHeight || 0) - (el.clientHeight || 0));\
                                var style = null;\
                                try {{ style = getComputedStyle(el); }} catch (_e) {{}}\
                                var ox = style ? (style.overflowX || style.overflow || '') : '';\
                                var oy = style ? (style.overflowY || style.overflow || '') : '';\
                                var allowX = ox === 'auto' || ox === 'scroll' || ox === 'overlay';\
                                var allowY = oy === 'auto' || oy === 'scroll' || oy === 'overlay';\
                                var consumesX = allowX && ((dx > 0 && el.scrollLeft < maxX) || (dx < 0 && el.scrollLeft > 0));\
                                var consumesY = allowY && ((dy > 0 && el.scrollTop < maxY) || (dy < 0 && el.scrollTop > 0));\
                                if (consumesX || consumesY) {{ scrollTarget = el; break; }}\
                                el = el.parentElement;\
                            }}\
                            if (!scrollTarget) scrollTarget = root;\
                            if (scrollTarget === root && root && typeof root.scrollBy === 'function') {{\
                                var beforeX = root.scrollLeft, beforeY = root.scrollTop;\
                                root.scrollBy(dx, dy);\
                                if (root.scrollLeft !== beforeX || root.scrollTop !== beforeY) setTimeout(function() {{\
                                    try {{ document.dispatchEvent(new Event('scroll', {{bubbles:false}})); }} catch (_e) {{}}\
                                    try {{ globalThis.dispatchEvent(new Event('scroll', {{bubbles:false}})); }} catch (_e) {{}}\
                                }}, 0);\
                            }} else if (scrollTarget && typeof scrollTarget.scrollBy === 'function') scrollTarget.scrollBy(dx, dy);\
                        }})()",
                        x = x,
                        y = y,
                        delta_x = delta_x,
                        delta_y = delta_y,
                        alt_key = alt_key,
                        ctrl_key = ctrl_key,
                        meta_key = meta_key,
                        shift_key = shift_key,
                    );
            execute(page, &code)
        }
        "mouseMoved" => {
            let options = json!({
                "bubbles": true, "cancelable": true, "clientX": x, "clientY": y,
                "button": button_code, "buttons": buttons, "altKey": alt_key,
                "ctrlKey": ctrl_key, "metaKey": meta_key, "shiftKey": shift_key
            });
            let code = format!(
                "(function() {{ var target = document.elementFromPoint({x},{y}) || document.body;
                 if (target) target.dispatchEvent(globalThis.__obscura_markTrusted(
                    new MouseEvent('mousemove', {options}))); }})()"
            );
            execute(page, &code)
        }
        _ => Err(format!("Unsupported mouse event type: {event_type}")),
    }
}

fn dispatch_key(page: &mut Page, params: &Value) -> Result<Vec<u8>, String> {
    let event_type = required_string(params, "type", 32)?;
    let key = params.get("key").and_then(Value::as_str).unwrap_or("");
    let code = params.get("code").and_then(Value::as_str).unwrap_or("");
    let text = params.get("text").and_then(Value::as_str).unwrap_or("");
    if key.len() > 128 || code.len() > 128 || text.len() > MAX_INPUT_TEXT {
        return Err("Keyboard field exceeds input bounds".into());
    }
    let modifiers = bounded_integer(params, "modifiers", 0, 15)?;
    let (alt_key, ctrl_key, meta_key, shift_key) = modifier_flags(modifiers);
    let location = bounded_integer(params, "location", 0, 3)?;
    let repeat = params.get("autoRepeat").and_then(Value::as_bool).unwrap_or(false);
    let kind = match event_type {
        "keyDown" | "rawKeyDown" => "keydown",
        "keyUp" => "keyup",
        "char" => return execute(page, &insert_text_js(text)),
        _ => return Err(format!("Unsupported key event type: {event_type}")),
    };
    let options = json!({
        "bubbles":true,"cancelable":true,"key":key,"code":code,
        "altKey":alt_key,"ctrlKey":ctrl_key,"metaKey":meta_key,
        "shiftKey":shift_key,"repeat":repeat,"location":location
    });
    let default_action = if kind == "keydown" {
        if key == "Backspace" {
            BACKSPACE_JS.to_string()
        } else if key == "Enter" {
            // A textarea edits its selection; an input submits its form.
            let insert = insert_text_js("\n");
            format!("if (target.localName === 'textarea') {{ {insert}; }}
                else {{ var form = target.form || (target.closest && target.closest('form'));
                    if(form && typeof form.requestSubmit === 'function') form.requestSubmit(); }}")
        } else if !text.is_empty() && !ctrl_key && !meta_key && !alt_key {
            insert_text_js(text)
        } else {
            String::new()
        }
    } else {
        String::new()
    };
    execute(page, &format!(
        "(function() {{ var target = document.activeElement || document.body;
            if (!target) return;
            var event = globalThis.__obscura_markTrusted(new KeyboardEvent({kind}, {options}));
            if (!target.dispatchEvent(event)) return;
            {default_action};
        }})()", kind=js_str(kind)
    ))
}
