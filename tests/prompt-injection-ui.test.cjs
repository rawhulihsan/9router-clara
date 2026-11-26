// Run: node tests/prompt-injection-ui.test.cjs
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { transform, loadBindings } = require("next/dist/build/swc");

(async () => {
  await loadBindings();
  const filename = path.join(__dirname, "../src/app/(dashboard)/dashboard/prompt-injection/PromptInjectionClient.js");
  const { code } = await transform(fs.readFileSync(filename, "utf8"), {
    filename, jsc: { parser: { syntax: "ecmascript", jsx: true }, transform: { react: { runtime: "automatic" } }, target: "es2022" }, module: { type: "commonjs" },
  });
  const state = [];
  let cursor = 0;
  let mounted = false;
  const effects = [];
  const calls = [];
  let failSave = false;
  const config = { global: null, prompts: {}, userPrompts: {} };
  const module = { exports: {} };
  const react = {
    useState(initial) { const i = cursor++; if (!(i in state)) state[i] = typeof initial === "function" ? initial() : initial; return [state[i], (value) => { state[i] = typeof value === "function" ? value(state[i]) : value; }]; },
    useCallback: (fn) => fn,
    useEffect(fn) { if (!mounted) effects.push(fn); },
  };
  vm.runInNewContext(code, {
    module, exports: module.exports, URLSearchParams, console, window: { confirm: () => true },
    require(name) {
      if (name === "react") return react;
      if (name.endsWith("/Button")) return "button";
      if (name.endsWith("/Card")) return "section";
      if (name === "@/i18n/runtime") return { translate: (text) => text, onLocaleChange: () => () => {} };
      return require(name);
    },
    async fetch(url, options = {}) {
      calls.push({ url, ...options });
      if (url === "/api/keys") return { ok: true, json: async () => ({ keys: [{ id: "key-1", name: "Example", key: "not-rendered" }] }) };
      if (options.method === "PUT") {
        if (failSave) return { ok: false, json: async () => ({ error: "Save rejected" }) };
        const body = JSON.parse(options.body);
        if ("global" in body) config.global = body.global;
        else if (body.keyId) config.userPrompts[body.keyId] = body;
        else config.prompts[body.model] = body;
      }
      if (options.method === "DELETE") {
        const query = new URL(url, "http://test").searchParams;
        delete (query.has("keyId") ? config.userPrompts : config.prompts)[query.get("keyId") || query.get("model")];
      }
      return { ok: true, json: async () => config };
    },
  });
  const render = () => { cursor = 0; const tree = module.exports.default(); mounted = true; return tree; };
  const nodes = (tree) => !tree || typeof tree !== "object" ? [] : Array.isArray(tree) ? tree.flatMap(nodes) : [tree, ...nodes(tree.props?.children)];
  const find = (predicate) => { const node = nodes(render()).find(predicate); assert.ok(node, "UI element exists"); return node; };
  const text = (value) => Array.isArray(value) ? value.map(text).join("") : typeof value === "object" ? text(value?.props?.children) : value || "";
  const button = (label) => find((node) => node.type === "button" && text(node.props.children) === label);
  const change = (node, value) => node.props.onChange({ target: { value } });
  const submit = () => find((node) => node.type === "form").props.onSubmit({ preventDefault() {} });
  render();
  await Promise.all(effects.map((effect) => effect()));
  await new Promise(setImmediate);
  assert.equal(nodes(render()).some((node) => text(node.props?.children).includes("not-rendered")), false);
  await submit();
  assert.equal(calls.filter((call) => call.method === "PUT").length, 0, "empty prompt blocked");
  change(find((node) => node.type === "textarea"), "Global prompt");
  await submit();
  assert.equal(config.global.content, "Global prompt");
  button("New injection").props.onClick();
  change(find((node) => node.type === "select" && node.props.value === "global"), "key");
  change(find((node) => node.type === "select" && node.props.value === ""), "key-1");
  change(find((node) => node.type === "textarea"), "Key prompt");
  await submit();
  assert.equal(config.userPrompts["key-1"].content, "Key prompt");
  button("New injection").props.onClick();
  change(find((node) => node.type === "select" && node.props.value === "global"), "model");
  change(find((node) => node.type === "input" && node.props.placeholder === "provider/model"), "vendor/dynamic-model");
  change(find((node) => node.type === "select" && node.props.value === "single"), "chat");
  let areas = nodes(render()).filter((node) => node.type === "textarea");
  change(areas[0], "Question");
  areas = nodes(render()).filter((node) => node.type === "textarea");
  change(areas[1], "Answer");
  change(find((node) => node.type === "select" && node.props.value === "append"), "prepend");
  await submit();
  assert.equal(config.prompts["vendor/dynamic-model"].mode, "chat");
  assert.equal(config.prompts["vendor/dynamic-model"].position, "prepend");
  assert.equal(config.prompts["vendor/dynamic-model"].turns.length, 2);
  find((node) => node.type === "input" && node.props.type === "checkbox").props.onChange({ target: { checked: false } });
  await submit();
  assert.equal(config.prompts["vendor/dynamic-model"].enabled, false);
  failSave = true;
  await submit();
  assert.equal(text(find((node) => node.props?.role === "alert").props.children), "Save rejected");
  failSave = false;
  for (let i = 0; i < 3; i++) await button("Delete").props.onClick();
  assert.equal(config.global, null);
  assert.equal(Object.keys(config.userPrompts).length, 0);
  assert.equal(Object.keys(config.prompts).length, 0);
  console.log("PASS: UI compiles; global/key/model CRUD, chat/prepend, disable, validation, server errors, secret-free labels");
})().catch((err) => { console.error(err); process.exitCode = 1; });
