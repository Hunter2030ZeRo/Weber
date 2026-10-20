globalThis.weberBindingPrepare = () => {
  const section = document.createElement("section"); section.id = "binding-probe";
  const text = document.createTextNode("initial"); section.appendChild(text);
  const input = document.createElement("input"); input.id = "binding-input";
  const checkbox = document.createElement("input"); checkbox.id = "binding-checkbox"; checkbox.setAttribute("type", "checkbox");
  document.body.append(section, input, checkbox);
  globalThis.weberBindingState = { section, text, input, checkbox, origin: performance.timeOrigin };
};
globalThis.weberBindingContracts = () => {
  const { section, text, input, checkbox, origin } = globalThis.weberBindingState;
  const check = (value, message) => { if (!value) throw new Error(message); };
  const cases = [], test = (name, action) => { action(); cases.push(name); };
  const parse = JSON.parse, stringify = JSON.stringify;
  JSON.parse = JSON.stringify = () => { throw new Error("JSON used inside binary DOM exchange"); };
  try {
    test("Servo character data is authoritative", () => { check(section.firstChild === text && text.data === "native 한글 😀\ufffd", "Stale text mirror"); check(section.textContent === text.data, "Element native text read"); });
    test("Servo form state is authoritative", () => { check(input.value === "native 입력 😀" && checkbox.checked === true, "Stale input/checked mirror"); });
    test("native clone preserves authoritative text and form state", () => {
      const copied = section.cloneNode(true), copiedInput = input.cloneNode(), copiedCheckbox = checkbox.cloneNode();
      check(copied.firstChild !== text && copied.firstChild.data === text.data, "Native text cloning");
      check(copiedInput.value === input.value && copiedCheckbox.checked === checkbox.checked, "Native form cloning");
      copied.firstChild.data = "independent clone"; check(text.data === "native 한글 😀\ufffd", "Clone aliases original text");
    });
    test("native template and fragment clone handle ownership", () => {
      const template = document.createElement("template"); template.innerHTML = '<span data-x="one">A</span><!--B-->';
      const copied = template.cloneNode(true), shallow = template.cloneNode(false), fragment = template.content.cloneNode(true);
      check(shallow.content.childNodes.length === 0 && copied.content.childNodes.length === 2, "Template clone depth");
      check(copied.content.querySelector("span").textContent === "A" && fragment.firstChild !== template.content.firstChild, "Fragment clone identity");
      copied.content.firstChild.setAttribute("data-x", "two"); check(template.content.firstChild.getAttribute("data-x") === "one", "Clone Attr independence");
      check(copied.content.lastChild.data === "B", "Cloned comment handle");
    });
    test("read-after-write and observer oldValue", () => {
      const observer = new MutationObserver(() => {}); observer.observe(text, { characterData: true, characterDataOldValue: true });
      text.data = "AOT 왕복 😀\udfff"; const records = observer.takeRecords(); observer.disconnect();
      check(text.data === "AOT 왕복 😀\ufffd" && records.length === 1 && records[0].oldValue === "native 한글 😀\ufffd", "Character data write or oldValue");
      input.value = "AOT 입력"; checkbox.checked = false; check(input.value === "AOT 입력" && !checkbox.checked, "Form read-after-write");
    });
    test("detached native data and reinsertion", () => { section.removeChild(text); text.data = "detached 😀"; check(text.data === "detached 😀", "Detached native handle"); section.appendChild(text); check(section.firstChild === text, "Reinserted wrapper identity"); });
    test("native CSS uses binary queries", () => { section.style.width = "13px"; check(section.style.width === "13px", "Binary CSSOM"); });
    test("native selectors and wrapper identity", () => { check(document.querySelector("#binding-probe") === section && section.matches("section#binding-probe") && input.closest("body") === document.body, "Native selector result identity"); });
    test("wire preserves UTF-16 and binary64 independently of native DOM normalization", () => {
      const value = { text: "wire 😀\ud800\udfff", origin, negativeZero: -0 };
      const result = WeberWire.decode(WeberWire.encode(value));
      check(result.text === value.text && result.origin === origin && Object.is(result.negativeZero, -0), "Wire changed code units or floating point bits");
    });
    test("stable time origin", () => check(performance.timeOrigin === origin, "Clock changed across binary requests"));
    if (document._native) test("no text or form-value mirror slots", () => { check(!Object.prototype.hasOwnProperty.call(text, "_data") && !Object.prototype.hasOwnProperty.call(input, "_value") && !Object.prototype.hasOwnProperty.call(checkbox, "_checked"), "Duplicate native state"); });
  } finally { JSON.parse = parse; JSON.stringify = stringify; }
  return { passed: true, cases, text: text.data, input: input.value, checked: checkbox.checked };
};
