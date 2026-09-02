import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";
import { getAgentByName } from "agents";
import type { Env, NimbleRunAgent } from "../src/agent";
import { waitUntil } from "./helpers";

const typedEnv = env as unknown as Env;

/**
 * Reproduces a start-time gap: startRun()'s fiber callback previously built
 * the Nimble client (this.client(apiKeyOverride)) BEFORE the try/catch that
 * records a create failure to the ledger. With neither an apiKeyOverride nor
 * env.NIMBLE_API_KEY set, this.client() throws synchronously outside that
 * try/catch, so the ledger row initialized by startRun() before startFiber
 * (status: "queued") is never updated — leaving a durable run stuck queued
 * forever with no lastError to explain why.
 */
describe("NimbleRunAgent — startRun records a definitive failure when no credential is available", () => {
  let createCalls = 0;

  beforeEach(() => {
    createCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(String(input), init);
        if (request.url.endsWith("/runs") && request.method === "POST") {
          createCalls += 1;
          return new Response(JSON.stringify({ id: "task_run_unreachable", status: "queued" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response("not found", { status: 404 });
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("marks the ledger failed with a sanitized message instead of leaving it queued forever", async () => {
    const stub = (await getAgentByName(
      typedEnv.NIMBLE_RUN_AGENT,
      "session-no-credential",
    )) as unknown as NimbleRunAgent;

    // Simulate the deployment condition: no per-user override on this call,
    // and no server-side fallback key configured at all.
    await runInDurableObject(stub as unknown as DurableObjectStub, async (instance) => {
      (instance as unknown as { env: { NIMBLE_API_KEY?: string } }).env.NIMBLE_API_KEY = undefined;
    });

    const outcome = await stub.startRun({
      nimbleAgentId: "wsa_no_credential",
      request: { input: "no credential is available for this create" },
    });

    await waitUntil(async () => {
      const status = await stub.getRunLifecycleStatus(outcome.fiberKey);
      return status.status === "failed";
    });

    const status = await stub.getRunLifecycleStatus(outcome.fiberKey);
    expect(status.status).toBe("failed");
    expect(status.lastError).toMatch(/no nimble api key available/i);
    expect(createCalls).toBe(0); // never even reached the provider

    const result = await stub.getRunTypedResult(outcome.fiberKey);
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/no nimble api key available/i);
  });
});
