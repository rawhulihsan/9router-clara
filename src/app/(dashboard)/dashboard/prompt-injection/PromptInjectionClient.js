"use client";

import { useCallback, useEffect, useState } from "react";
import Button from "@/shared/components/Button";
import Card from "@/shared/components/Card";
import { translate, onLocaleChange } from "@/i18n/runtime";

const API = "/api/prompt-injection";
const fieldClass = "w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text-main";
const emptyEntry = () => ({ mode: "single", content: "", turns: [{ role: "user", content: "" }, { role: "assistant", content: "" }], position: "append", enabled: true });

async function request(url, options) {
  const response = await fetch(url, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || translate("Request failed"));
  return data;
}

export default function PromptInjectionClient() {
  const [config, setConfig] = useState(null);
  const [keys, setKeys] = useState([]);
  const [scope, setScope] = useState("global");
  const [target, setTarget] = useState("");
  const [entry, setEntry] = useState(emptyEntry);
  const [editing, setEditing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [, setLocale] = useState(0);

  useEffect(() => onLocaleChange(() => setLocale((n) => n + 1)), []);
  const load = useCallback(async () => {
    try {
      const data = await request(API);
      setConfig(data);
      // Key labels are optional; never retain or render API-key secrets.
      try {
        const data = await request("/api/keys");
        setKeys((data.keys || []).map(({ id, name }) => ({ id, name })));
      } catch { /* Existing key targets remain editable by ID. */ }
      return true;
    } catch (err) {
      setError(err.message);
      return false;
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { Promise.resolve().then(load); }, [load]);

  const reset = () => {
    setScope("global");
    setTarget("");
    setEntry(emptyEntry());
    setEditing(false);
    setError("");
    setNotice("");
  };
  const edit = (row) => {
    setScope(row.scope);
    setTarget(row.target);
    setEntry({ ...emptyEntry(), ...row.entry });
    setEditing(true);
    setError("");
    setNotice("");
  };
  const rows = [];
  if (config?.global) rows.push({ scope: "global", target: "", entry: config.global });
  for (const [target, value] of Object.entries(config?.userPrompts || {})) rows.push({ scope: "key", target, entry: value });
  for (const [target, value] of Object.entries(config?.prompts || {})) rows.push({ scope: "model", target, entry: value });
  const scopeLabel = (value) => translate({ global: "Global", key: "API key", model: "Model" }[value]);
  const targetLabel = (row) => row.scope === "global" ? translate("All requests") : row.scope === "key" ? keys.find((key) => key.id === row.target)?.name || row.target : row.target;

  const save = async (event) => {
    event.preventDefault();
    setError("");
    setNotice("");
    if (scope !== "global" && !target.trim()) return setError(translate("Choose an injection target."));
    if (entry.mode === "single" ? !entry.content.trim() : !entry.turns.length || entry.turns.some((turn) => !turn.content.trim())) {
      return setError(translate("Fill in the prompt or every chat turn before saving."));
    }
    const fields = { mode: entry.mode, position: entry.position, enabled: entry.enabled, ...(entry.mode === "chat" ? { turns: entry.turns } : { content: entry.content }) };
    const payload = scope === "global" ? { global: fields } : { [scope === "key" ? "keyId" : "model"]: target.trim(), ...fields };
    if (!editing && rows.some((row) => row.scope === scope && row.target === target.trim()) && !window.confirm(translate("Replace the existing injection for this target?"))) return;
    setSaving(true);
    try {
      await request(API, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      setEditing(true);
      if (await load()) setNotice(translate("Injection saved"));
    } catch (err) { setError(err.message); }
    finally { setSaving(false); }
  };
  const remove = async (row) => {
    if (!window.confirm(translate("Delete this injection?"))) return;
    setSaving(true);
    setError("");
    setNotice("");
    try {
      if (row.scope === "global") {
        await request(API, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ global: null }) });
      } else {
        const query = new URLSearchParams({ [row.scope === "key" ? "keyId" : "model"]: row.target });
        await request(`${API}?${query}`, { method: "DELETE" });
      }
      reset();
      if (await load()) setNotice(translate("Injection deleted"));
    } catch (err) { setError(err.message); }
    finally { setSaving(false); }
  };

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-text-main">Prompt Injection</h1>
          <p className="mt-1 text-sm text-text-muted">Add system prompts or scripted chat history to global, API-key, or model requests.</p>
        </div>
        <Button icon="add" onClick={reset} disabled={saving}>New injection</Button>
      </div>
      {error && <div role="alert" className="rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-500">{error}</div>}
      {notice && <p role="status" className="text-sm text-green-600">{notice}</p>}
      <Card className="p-5">
        <h2 className="mb-4 text-lg font-semibold">Configured injections</h2>
        {loading ? <p role="status">Loading...</p> : !config ? <Button variant="secondary" onClick={load}>Retry</Button> : rows.length === 0 ? <p className="text-sm text-text-muted">No prompt injections configured.</p> : (
          <ul className="divide-y divide-border">
            {rows.map((row) => (
              <li key={`${row.scope}:${row.target}`} className="flex flex-wrap items-center gap-3 py-3">
                <div className="min-w-0 flex-1">
                  <p className="break-words font-medium" data-i18n-skip>{scopeLabel(row.scope)} · {targetLabel(row)}</p>
                  <p className="text-xs text-text-muted" data-i18n-skip>{translate(row.entry.mode === "chat" ? "Chat script" : "System prompt")} · {translate(row.entry.position === "prepend" ? "Prepend" : "Append")} · {translate(row.entry.enabled === false ? "Disabled" : "Enabled")}</p>
                  <p className="mt-1 truncate text-sm text-text-muted" data-i18n-skip>{row.entry.mode === "chat" ? (row.entry.turns || []).map((turn) => turn.content).join(" / ") : row.entry.content}</p>
                </div>
                <Button variant="secondary" size="sm" onClick={() => edit(row)} disabled={saving}>Edit</Button>
                <Button variant="danger" size="sm" onClick={() => remove(row)} disabled={saving}>Delete</Button>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card className="p-5">
        <h2 className="mb-4 text-lg font-semibold">{editing ? "Edit injection" : "New injection"}</h2>
        <form onSubmit={save} className="flex flex-col gap-4">
          <fieldset disabled={saving || loading || !config} className="flex min-w-0 flex-col gap-4 disabled:opacity-60">
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="flex flex-col gap-1 text-sm">
                <span>Scope</span>
                <select className={fieldClass} value={scope} disabled={editing} onChange={(event) => { setScope(event.target.value); setTarget(""); }}>
                  {["global", "key", "model"].map((value) => <option key={value} value={value}>{scopeLabel(value)}</option>)}
                </select>
              </label>
              {scope === "key" && <label className="flex flex-col gap-1 text-sm">
                <span>API key</span>
                <select className={fieldClass} value={target} disabled={editing} onChange={(event) => setTarget(event.target.value)} required>
                  <option value="">{translate("Select API key")}</option>
                  {keys.map((key) => <option key={key.id} value={key.id}>{key.name || key.id}</option>)}
                  {target && !keys.some((key) => key.id === target) && <option value={target}>{target}</option>}
                </select>
              </label>}
              {scope === "model" && <label className="flex flex-col gap-1 text-sm">
                <span>Model</span>
                {/* ponytail: raw model IDs support dynamic providers; add picker when catalog covers them. */}
                <input className={fieldClass} value={target} disabled={editing} onChange={(event) => setTarget(event.target.value)} placeholder="provider/model" required />
                <span className="text-xs text-text-muted">Use the exact model ID sent by your client.</span>
              </label>}
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="flex flex-col gap-1 text-sm">
                <span>Mode</span>
                <select className={fieldClass} value={entry.mode} onChange={(event) => setEntry({ ...entry, mode: event.target.value })}>
                  <option value="single">{translate("System prompt")}</option>
                  <option value="chat">{translate("Chat script")}</option>
                </select>
              </label>
              <label className="flex flex-col gap-1 text-sm">
                <span>Position</span>
                <select className={fieldClass} value={entry.position} onChange={(event) => setEntry({ ...entry, position: event.target.value })}>
                  <option value="append">{translate("Append")}</option>
                  <option value="prepend">{translate("Prepend")}</option>
                </select>
              </label>
            </div>
            {entry.mode === "single" ? <label className="flex flex-col gap-1 text-sm">
              <span>System prompt</span>
              <textarea className={`${fieldClass} font-mono`} rows={8} value={entry.content} onChange={(event) => setEntry({ ...entry, content: event.target.value })} required />
            </label> : <div className="flex flex-col gap-3">
              <p className="text-sm text-text-muted">Chat turns are injected as conversation history before the real chat.</p>
              {entry.turns.map((turn, index) => <div key={index} className="flex flex-wrap items-start gap-2">
                <label className="flex flex-col gap-1 text-sm">
                  <span>{translate("Role")} {index + 1}</span>
                  <select className={fieldClass} value={turn.role} onChange={(event) => setEntry({ ...entry, turns: entry.turns.map((item, i) => i === index ? { ...item, role: event.target.value } : item) })}>
                    <option value="user">{translate("User")}</option>
                    <option value="assistant">{translate("Assistant")}</option>
                  </select>
                </label>
                <label className="flex min-w-0 flex-1 flex-col gap-1 text-sm">
                  <span>{translate("Message")} {index + 1}</span>
                  <textarea className={fieldClass} rows={3} value={turn.content} onChange={(event) => setEntry({ ...entry, turns: entry.turns.map((item, i) => i === index ? { ...item, content: event.target.value } : item) })} required />
                </label>
                <Button type="button" variant="ghost" size="sm" onClick={() => setEntry({ ...entry, turns: entry.turns.filter((_, i) => i !== index) })}>{translate("Remove turn")} {index + 1}</Button>
              </div>)}
              <Button type="button" variant="secondary" className="self-start" onClick={() => setEntry({ ...entry, turns: [...entry.turns, { role: entry.turns.at(-1)?.role === "user" ? "assistant" : "user", content: "" }] })}>Add turn</Button>
            </div>}
            <div className="flex items-center justify-between gap-3">
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={entry.enabled} onChange={(event) => setEntry({ ...entry, enabled: event.target.checked })} />Enabled</label>
              <Button type="submit" loading={saving}>Save injection</Button>
            </div>
          </fieldset>
        </form>
      </Card>
    </div>
  );
}
