import { env, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { getAgentByName } from "agents";
import type { Env, NimbleRunAgent } from "../src/agent";

const typedEnv = env as unknown as Env;

const AGENT_ID = "wsa_recover1";
const RUN_ID = "task_run_recover1";

async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 2000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error("waitUntil timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/**
 * These tests exercise the real Durable Object under workerd (via
 * cloudflare:test), not a mock DO. `evictDurableObject` tears down the
 * in-memory instance while preserving durable SQLite storage — the same
 * mechanism a real restart triggers — proving the kill/restart recovery
 * requirement locally without deploying anything.
 *
 * startFiber() durably accepts work and runs the callback in the
 * background (waitForCompletion defaults to false), so assertions poll for
 * the observable side effect (a recorded fetch call) rather than assuming
 * synchronous completion.
 *
 * All three tests share ONE fetch mock installed in beforeEach (via the
 * onAuthHeader/pollStatusOverride hooks below) rather than re-stubbing
 * global fetch mid-test — a second vi.stubGlobal() call while a Durable
 * Object's background fiber was scheduled against the first mock was
 * observed to hang evictDurableObject()'s in-flight-request drain
 * indefinitely.
 */
describe("NimbleRunAgent — duplicate-create prevention and restart recovery", () => {
  let createCalls = 0;
  let pollCalls = 0;
  /** The run only reaches "completed" once poll count crosses this — lets
   *  a test evict mid-run (while still "running") without the eviction
   *  drain waiting on an in-flight fetch. */
  let completeAfterPollCount = 2;
  let onAuthHeader: ((auth: string) => void) | undefined;
  let pollStatusOverride: (() => string) | undefined;

  beforeEach(() => {
    createCalls = 0;
    pollCalls = 0;
    completeAfterPollCount = 2;
    onAuthHeader = undefined;
    pollStatusOverride = undefined;

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(String(input), init);
        const url = request.url;
        const auth = request.headers.get("Authorization") ?? "";
        onAuthHeader?.(auth);
        if (url.endsWith("/runs") && request.method === "POST") {
          createCalls += 1;
          return new Response(JSON.stringify({ id: RUN_ID, status: "queued" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        if (url.includes(`/runs/${RUN_ID}`) && !url.endsWith("/result")) {
          pollCalls += 1;
          const status = pollStatusOverride
            ? pollStatusOverride()
            : pollCalls > completeAfterPollCount
              ? "completed"
              : "running";
          return new Response(JSON.stringify({ id: RUN_ID, status }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        if (url.endsWith("/result")) {
          // Real Agent API V2 envelope: content/trust nest under `output`.
          return new Response(
            JSON.stringify({
              run: { id: RUN_ID, status: "completed", web_search_agent_id: AGENT_ID },
              output: {
                type: "text",
                content: "done",
                trust: { confidence: "high", reasoning: "single source", claims: [], sources: [] },
              },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response("not found", { status: 404 });
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("never issues a second create when the same input is started twice (dedupe via startFiber idempotencyKey)", async () => {
    const stub = (await getAgentByName(
      typedEnv.NIMBLE_RUN_AGENT,
      "session-dedupe",
    )) as unknown as NimbleRunAgent;

    const request = { input: "same task every time" };
    const first = await stub.startRun({ nimbleAgentId: AGENT_ID, request });
    await waitUntil(() => createCalls >= 1);
    const second = await stub.startRun({ nimbleAgentId: AGENT_ID, request });

    expect(first.fiberKey).toBe(second.fiberKey);
    // Give any (incorrect) second create a chance to fire before asserting.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(createCalls).toBe(1);
  });

  it("preserves terminal state and override provenance when a duplicate omits the original override", async () => {
    completeAfterPollCount = 0;
    const stub = (await getAgentByName(
      typedEnv.NIMBLE_RUN_AGENT,
      "session-dedupe-terminal-override",
    )) as unknown as NimbleRunAgent;
    const request = { input: "same completed override-backed task" };

    const first = await stub.startRun({
      nimbleAgentId: AGENT_ID,
      request,
      apiKeyOverride: "user-override-key",
    });
    await waitUntil(async () => {
      const status = await stub.getRunLifecycleStatus(first.fiberKey, "user-override-key");
      return status.status === "completed";
    });

    const duplicate = await stub.startRun({ nimbleAgentId: AGENT_ID, request });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const status = await stub.getRunLifecycleStatus(first.fiberKey);
    const resultWithoutOriginalOverride = await stub.getRunTypedResult(first.fiberKey);

    expect(duplicate.fiberKey).toBe(first.fiberKey);
    expect(createCalls).toBe(1);
    expect(status.status).toBe("completed");
    expect(resultWithoutOriginalOverride.status).toBe("completed");
    expect(resultWithoutOriginalOverride.result).toBeNull();
    expect(resultWithoutOriginalOverride.error).toMatch(/re-supply the same override/i);
  });

  it("resumes polling after eviction without re-issuing create (onFiberRecovered)", async () => {
    const stub = (await getAgentByName(
      typedEnv.NIMBLE_RUN_AGENT,
      "session-recover",
    )) as unknown as NimbleRunAgent;

    const outcome = await stub.startRun({
      nimbleAgentId: AGENT_ID,
      request: { input: "evict me mid-run" },
    });
    // Let the run become observably "running" (at least one poll) before
    // evicting — proves eviction happens while genuinely in flight, not
    // before the create even fired.
    await waitUntil(() => pollCalls >= 1);
    expect(createCalls).toBe(1);

    await evictDurableObject(stub as unknown as DurableObjectStub);

    // Re-fetch the stub; a fresh instance is created transparently, and its
    // onStart()-driven fiber recovery must resume polling — never re-create.
    const stub2 = (await getAgentByName(
      typedEnv.NIMBLE_RUN_AGENT,
      "session-recover",
    )) as unknown as NimbleRunAgent;

    await waitUntil(async () => {
      const status = await stub2.getRunLifecycleStatus(outcome.fiberKey);
      return status.status === "completed";
    }, 5000);

    expect(createCalls).toBe(1); // still exactly one create — never retried
    const finalStatus = await stub2.getRunLifecycleStatus(outcome.fiberKey);
    expect(finalStatus.runId).toBe(RUN_ID);
    expect(finalStatus.recoveredCount).toBeGreaterThanOrEqual(1);
  }, 10000);

  it(
    "onFiberRecovered fails closed for an override-backed run - never silently falls back to the server key",
    async () => {
      // Drives the exact production onFiberRecovered() code path via
      // runInDurableObject (cloudflare:test's supported way to call/spy on
      // a live Durable Object instance's methods) with a synthetic
      // FiberRecoveryContext, rather than evictDurableObject() — which was
      // observed to hang indefinitely for this scenario's eviction-drain
      // logic (Miniflare-specific; unrelated to the code under test). This
      // still exercises the real onFiberRecovered implementation, not a
      // reimplementation of it.
      const stub = (await getAgentByName(
        typedEnv.NIMBLE_RUN_AGENT,
        "session-override-recover",
      )) as unknown as NimbleRunAgent;

      let sawOverrideKeyHeader = false;
      let sawFallbackKeyHeader = false;
      onAuthHeader = (auth) => {
        if (auth === "Bearer user-override-key") sawOverrideKeyHeader = true;
        if (auth.includes(typedEnv.NIMBLE_API_KEY ?? " never-set-fallback")) {
          sawFallbackKeyHeader = true;
        }
      };
      completeAfterPollCount = 50; // never completes on its own within this test

      const outcome = await stub.startRun({
        nimbleAgentId: AGENT_ID,
        request: { input: "override-backed run, recover me" },
        apiKeyOverride: "user-override-key",
      });
      await waitUntil(() => pollCalls >= 1);
      expect(createCalls).toBe(1);
      expect(sawOverrideKeyHeader).toBe(true);
      const pollCallsBeforeRecovery = pollCalls;

      const recoveryResult = await runInDurableObject(
        stub as unknown as DurableObjectStub,
        async (instance) => {
          const agent = instance as unknown as NimbleRunAgent;
          return agent.onFiberRecovered({
            id: "synthetic-fiber-id",
            name: outcome.fiberKey,
            idempotencyKey: outcome.fiberKey,
            snapshot: {
              nimbleAgentId: AGENT_ID,
              runId: RUN_ID,
              usedOverrideKey: true,
            },
            createdAt: Date.now(),
            recoveryReason: "interrupted",
          } as never);
        },
      );

      // Recovery must fail closed: no additional poll fired (no fallback-key
      // request), the create was never retried, and the returned/ledger
      // status both say "blocked", not "completed"/"running".
      expect(recoveryResult).toMatchObject({ status: "error", error: "override-key-recovery-blocked-fail-closed" });
      expect(createCalls).toBe(1); // never retried the create
      expect(sawFallbackKeyHeader).toBe(false); // never substituted the server key
      expect(pollCalls).toBe(pollCallsBeforeRecovery); // no unauthorized poll happened during recovery

      const finalStatus = await stub.getRunLifecycleStatus(outcome.fiberKey);
      expect(finalStatus.status).toBe("recovery-blocked");

      // getRunTypedResult must also refuse to silently use the fallback key
      // for an override-backed run when no override is re-supplied.
      const resultWithoutOverride = await stub.getRunTypedResult(outcome.fiberKey);
      expect(resultWithoutOverride.error).toMatch(/re-supply/i);
      expect(sawFallbackKeyHeader).toBe(false);

      // Re-supplying the same override resumes it explicitly (never automatic).
      completeAfterPollCount = 0; // next poll reports "completed"
      const resumed = await stub.resumeWithOverride(outcome.fiberKey, "user-override-key");
      expect(resumed.status).toBe("completed");
      expect(createCalls).toBe(1); // resuming never re-creates either
    },
    15000,
  );
});
