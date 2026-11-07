import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;

async function setupDb() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-model-routing-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  const shutdownListeners = new Map(["beforeExit", "SIGINT", "SIGTERM"].map(event => [event, process.listeners(event)]));

  const { createProviderNode } = await import("@/models/index.js");
  const { getModelInfo } = await import("@/sse/services/model.js");

  return {
    createProviderNode,
    getModelInfo,
    cleanup() {
      global._dbAdapter?.instance?.close();
      delete global._dbAdapter;
      for (const [event, existing] of shutdownListeners) {
        for (const listener of process.listeners(event)) {
          if (!existing.includes(listener)) process.removeListener(event, listener);
        }
      }
      fs.rmSync(tempDir, { recursive: true, force: true });
    },
  };
}

describe("model routing", () => {
  let cleanup = () => {};

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    cleanup();
    cleanup = () => {};
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
  });

  it("routes an exact configured prefix ahead of a built-in provider alias", async () => {
    const ctx = await setupDb();
    cleanup = ctx.cleanup;

    await ctx.createProviderNode({
      id: "openai-compatible-chat-test",
      type: "openai-compatible",
      name: "Compatible CF Collision",
      prefix: "cf",
      apiType: "chat",
      baseUrl: "https://compatible.test/v1",
    });

    await expect(ctx.getModelInfo("cf/@cf/black-forest-labs/flux-2-klein-9b"))
      .resolves.toEqual({
        provider: "openai-compatible-chat-test",
        model: "@cf/black-forest-labs/flux-2-klein-9b",
      });
  });

  it.each(["openai-compatible", "anthropic-compatible", "custom-embedding"])(
    "routes th to a configured %s node but preserves native ids and other aliases",
    async (type) => {
      const ctx = await setupDb();
      cleanup = ctx.cleanup;
      const id = `${type}-tokenharbor`;
      await ctx.createProviderNode({
        id, type, name: "TokenHarbor", prefix: "th",
        apiType: "chat", baseUrl: "https://compatible.test/v1",
      });
      const model = "deepseek-v4.1-flash:free";
      await expect(ctx.getModelInfo(`th/${model}`)).resolves.toEqual({ provider: id, model });
      await expect(ctx.getModelInfo(`${id}/${model}`)).resolves.toEqual({ provider: id, model });
      await expect(ctx.getModelInfo(`tokenharbor/${model}`)).resolves.toEqual({ provider: "tokenharbor", model });
      await expect(ctx.getModelInfo("cf/@cf/model")).resolves.toEqual({ provider: "cloudflare-ai", model: "@cf/model" });
    },
  );

  it("keeps unconfigured aliases and explicit native ids on native providers", async () => {
    const ctx = await setupDb();
    cleanup = ctx.cleanup;
    await ctx.createProviderNode({
      id: "openai-compatible-chat-native-collision", type: "openai-compatible",
      name: "Native collision", prefix: "tokenharbor",
      apiType: "chat", baseUrl: "https://compatible.test/v1",
    });
    for (const prefix of ["th", "tokenharbor"]) {
      await expect(ctx.getModelInfo(`${prefix}/deepseek-v4.1-flash:free`)).resolves.toEqual({
        provider: "tokenharbor", model: "deepseek-v4.1-flash:free",
      });
    }
  });

  it("still routes non-reserved compatible node prefixes", async () => {
    const ctx = await setupDb();
    cleanup = ctx.cleanup;

    await ctx.createProviderNode({
      id: "openai-compatible-chat-test",
      type: "openai-compatible",
      name: "Compatible OCT",
      prefix: "oct",
      apiType: "chat",
      baseUrl: "https://compatible.test/v1",
    });

    await expect(ctx.getModelInfo("oct/gpt-image-1"))
      .resolves.toEqual({
        provider: "openai-compatible-chat-test",
        model: "gpt-image-1",
      });
  });
});
