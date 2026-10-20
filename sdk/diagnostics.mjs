// Loaded before application code, in packaged apps and Vite development.
(() => {
  if (globalThis.weberShowError) return;
  globalThis.weberShowError = error => {
    let message;
    try {
      const summary=String(error ?? 'Unknown application error').slice(0,4096);
      const stack=String(error?.stack ?? '').slice(0,4096);
      message=(stack && !stack.includes(summary) ? summary+'\n'+stack : stack || summary).slice(0,8192);
    } catch { message='Unable to format application error'; }
    let panel = document.getElementById('weber-error-overlay');
    if (!panel) {
      panel = document.createElement('section'); panel.id = 'weber-error-overlay'; panel.setAttribute('role', 'alert');
      panel.style.cssText = 'position:fixed;inset:16px;z-index:2147483647;overflow:auto;background:#fff;color:#171717;border:2px solid #b42318;padding:24px;font:14px/1.5 sans-serif;box-shadow:0 8px 40px #0004';
      const heading = document.createElement('h2'); heading.textContent = 'Application error'; panel.append(heading);
      const text = document.createElement('pre'); text.id = 'weber-error-message'; text.style.cssText = 'white-space:pre-wrap;overflow-wrap:anywhere'; panel.append(text);
      const dismiss = document.createElement('button'); dismiss.id = 'weber-error-dismiss'; dismiss.textContent = 'Dismiss'; dismiss.onclick = () => panel.remove(); panel.append(dismiss);
      const close = document.createElement('button'); close.id = 'weber-error-close'; close.textContent = 'Close window';
      close.onclick = () => {
        try { const capability = document.querySelector('meta[name="weber-native"]')?.getAttribute('content'); const result = JSON.parse(globalThis.weberHostCall(JSON.stringify({action:'native',capability,request:{op:'close'}}))); if (!result.ok) throw new Error(result.error?.message); }
        catch (error) { document.getElementById('weber-error-message').textContent = String(error).slice(0, 8192); }
      };
      panel.append(close); document.documentElement.append(panel);
    }
    document.getElementById('weber-error-message').textContent = message;
    try { globalThis.weberHostCall?.(JSON.stringify({ action: 'telemetry', data: { stage: 'application-error', message } })); } catch { /* The diagnostic remains visible without native telemetry. */ }
  };
  window.addEventListener('error', event => {
    const resource = event.target && event.target !== window ? event.target.src || event.target.href : undefined;
    globalThis.weberShowError(event.error || event.message || (resource ? `Unable to load ${resource}` : 'Application resource failed'));
  }, true);
  window.addEventListener('unhandledrejection', event => globalThis.weberShowError(event.reason || 'Unhandled promise rejection'));
})();
