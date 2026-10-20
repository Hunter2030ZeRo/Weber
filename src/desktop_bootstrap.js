// Generic DOM adapter entry. Application and shell components are native AOT.
window.__weberDom.call("desktop");
window.dispatchEvent(new Event("weber:desktop-mounted"));
