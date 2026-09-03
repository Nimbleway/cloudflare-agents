import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { getAgentByName } from "agents";
import type { Env, NimbleRunAgent, RunLedgerRow } from "../src/agent";
import { waitUntil } from "./helpers";

const typedEnv = env as unknown as Env;

const AGENT_ID = "wsa_stale1";
const RUN_ID = "task_run_stale1";

/**
 * Reproduces a recovery edge case: a run's background fiber stops
 * advancing (e.g. its poll loop's setTimeout does not survive a Durable
 * Object eviction) and the ledger is left frozen — a valid runId, but
 * status/pollAttempts never move even though direct provider reconciliation
 * shows the run is actually further along (or terminal). These tests drive
 * the real getRunLifecycleStatus()/getRunTypedResult() reconciliation path
 * against a synthetically frozen ledger row, not a reimplementation of it.
 */
describe("NimbleRunAgent — reconciles a frozen ledger row via a safe GET, never a create", () => {
  let createCalls = 0;
  let statusCalls = 0;
  let resultCalls = 0;
  let resultPayload: Record<string, unknown>;
  let resultStatus = 200;
  let seenAuthHeaders: string[] = [];

  beforeEach(() => {
    createCalls = 0;
    statusCalls = 0;
    resultCalls = 0;
    resultStatus = 200;
    resultPayload = {
      run: { id: RUN_ID, status: "completed", web_search_agent_id: AGENT_ID },
      output: {
        type: "text",
        content: "done",
        trust: {
          confidence: "high",
          reasoning: "single corroborated source",
          claims: [],
          sources: [{ type: "primary", url: "https://example.com" }],
        },
      },
    };
    seenAuthHeaders = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(String(input), init);
        const url = request.url;
        seenAuthHeaders.push(request.headers.get("Authorization") ?? "");
        if (url.endsWith("/runs") && request.method === "POST") {
          createCalls += 1;
          return new Response(JSON.stringify({ id: RUN_ID, status: "queued" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        if (url.includes(`/runs/${RUN_ID}`) && !url.endsWith("/result")) {
          statusCalls += 1;
          return new Response(JSON.stringify({ id: RUN_ID, status: "completed" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        if (url.endsWith("/result")) {
          resultCalls += 1;
          return new Response(JSON.stringify(resultPayload), {
            status: resultStatus,
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

  async function freezeLedgerRow(
    stub: DurableObjectStub,
    fiberKey: string,
    patch: Partial<RunLedgerRow>,
  ): Promise<void> {
    await runInDurableObject(stub, async (instance) => {
      const agent = instance as unknown as NimbleRunAgent;
      const existing = agent.state.runs[fiberKey];
      if (!existing) throw new Error(`no existing ledger row for ${fiberKey}`);
      const row: RunLedgerRow = { ...existing, ...patch };
      agent.setState({
        runs: {
          ...agent.state.runs,
          [fiberKey]: row,
        },
      });
    });
  }

  it("advances a frozen queued/pollAttempts=0 row to completed on the next status read, without a second create", async () => {
    const stub = (await getAgentByName(
      typedEnv.NIMBLE_RUN_AGENT,
      "session-reconcile-frozen",
    )) as unknown as NimbleRunAgent;

    const outcome = await stub.startRun({
      nimbleAgentId: AGENT_ID,
      request: { input: "reconcile me" },
    });
    expect(createCalls).toBe(1);

    // The real background fiber (startFiber's callback) keeps running
    // concurrently after startRun() resolves. Drain its one real poll (the
    // mock always answers "completed") before intervening, so the freeze
    // below can't race a still-in-flight legitimate poll.
    await waitUntil(() => statusCalls >= 1);

    // Simulate the exact reported symptom: status stuck at "queued" with
    // pollAttempts=0 and an updatedAt far enough in the past to be stale,
    // as if the background fiber's poll loop never advanced past the
    // create.
    await freezeLedgerRow(stub as unknown as DurableObjectStub, outcome.fiberKey, {
      status: "queued",
      pollAttempts: 0,
      updatedAt: Date.now() - 60_000,
    });

    // The row is already stale (updatedAt 60s in the past) the moment it's
    // frozen, so reconciliation fires on this very next read — proving the
    // self-heal happens on ordinary status polling, not on some special
    // second call.
    const statusCallsBefore = statusCalls;
    const after = await stub.getRunLifecycleStatus(outcome.fiberKey);

    expect(statusCalls).toBe(statusCallsBefore + 1); // exactly one safe GET, no more
    expect(after.status).toBe("completed");
    expect(after.pollAttempts).toBe(1);
    expect(after.lastError).toBeNull();
    expect(createCalls).toBe(1); // still exactly one create — reconciliation never creates

    // Result retrieval now works too, since status is reconciled to completed.
    const result = await stub.getRunTypedResult(outcome.fiberKey);
    expect(result.status).toBe("completed");
    expect(result.result).toMatchObject({
      outputType: "text",
      content: "done",
      trust: { confidence: "high" },
    });
  });

  it("reconciles a run after the local polling deadline without treating it as provider-failed", async () => {
    const stub = (await getAgentByName(
      typedEnv.NIMBLE_RUN_AGENT,
      "session-reconcile-poll-deadline",
    )) as unknown as NimbleRunAgent;

    const outcome = await stub.startRun({
      nimbleAgentId: AGENT_ID,
      request: { input: "continue after the adapter polling budget" },
    });
    await waitUntil(() => statusCalls >= 1);

    // This is the durable state pollUntilTerminal leaves after its local
    // five-minute budget expires: the provider still says running and the
    // adapter records a diagnostic. A later ordinary read must remain able
    // to perform one safe reconciliation GET.
    await freezeLedgerRow(stub as unknown as DurableObjectStub, outcome.fiberKey, {
      status: "running",
      lastError: "Polling deadline exceeded",
      updatedAt: Date.now() - 60_000,
    });

    const statusCallsBefore = statusCalls;
    const status = await stub.getRunLifecycleStatus(outcome.fiberKey);
    expect(statusCalls).toBe(statusCallsBefore + 1);
    expect(status.status).toBe("completed");
    expect(status.lastError).toBeNull();
    expect(createCalls).toBe(1);
  });

  it("returns a provider-failed run's structured result envelope and message", async () => {
    const stub = (await getAgentByName(
      typedEnv.NIMBLE_RUN_AGENT,
      "session-result-provider-failed",
    )) as unknown as NimbleRunAgent;

    const outcome = await stub.startRun({
      nimbleAgentId: AGENT_ID,
      request: { input: "surface a synthetic provider failure" },
    });
    await waitUntil(() => statusCalls >= 1);

    await freezeLedgerRow(stub as unknown as DurableObjectStub, outcome.fiberKey, {
      status: "failed",
      lastError: null,
      updatedAt: Date.now(),
    });
    resultPayload = {
      run: { id: RUN_ID, status: "failed", web_search_agent_id: AGENT_ID },
      error: { message: "Synthetic provider failure.", ref_id: RUN_ID },
    };

    const result = await stub.getRunTypedResult(outcome.fiberKey);
    expect(resultCalls).toBe(1);
    expect(result.status).toBe("failed");
    expect(result.error).toBe("Synthetic provider failure.");
    expect(result.result?.error).toEqual({
      message: "Synthetic provider failure.",
      refId: RUN_ID,
    });
    expect(createCalls).toBe(1);
  });

  it("never returns an ambiguous {result:null,error:null} for a terminal cancelled run", async () => {
    const stub = (await getAgentByName(
      typedEnv.NIMBLE_RUN_AGENT,
      "session-result-cancelled",
    )) as unknown as NimbleRunAgent;

    const outcome = await stub.startRun({
      nimbleAgentId: AGENT_ID,
      request: { input: "surface a synthetic cancellation" },
    });
    await waitUntil(() => statusCalls >= 1);

    // pollUntilTerminal's terminal-detection branch unconditionally clears
    // lastError to null for ANY terminal status (completed, failed, or
    // cancelled) — this is the exact durable state a real cancellation
    // leaves behind.
    await freezeLedgerRow(stub as unknown as DurableObjectStub, outcome.fiberKey, {
      status: "cancelled",
      lastError: null,
      updatedAt: Date.now(),
    });
    resultStatus = 422;
    resultPayload = { detail: "Run was cancelled by the operator." };

    const result = await stub.getRunTypedResult(outcome.fiberKey);
    expect(result.status).toBe("cancelled");
    // The bug this reproduces: without the fix, getRunTypedResult's
    // completed/failed-only gate never even attempts the result fetch for
    // "cancelled" and returns {result:null,error:null} — indistinguishable
    // from a run that is merely still in progress.
    expect(result.error).not.toBeNull();
    expect(result.error).toBe("Run was cancelled by the operator.");
    expect(result.result).toBeNull();
    expect(createCalls).toBe(1); // never a create
  });

  it("never returns error:null for a non-completed terminal run whose result endpoint answers 200 with no diagnostic", async () => {
    const stub = (await getAgentByName(
      typedEnv.NIMBLE_RUN_AGENT,
      "session-result-cancelled-empty-200",
    )) as unknown as NimbleRunAgent;

    const outcome = await stub.startRun({
      nimbleAgentId: AGENT_ID,
      request: { input: "surface a synthetic cancellation with an empty 200 envelope" },
    });
    await waitUntil(() => statusCalls >= 1);

    await freezeLedgerRow(stub as unknown as DurableObjectStub, outcome.fiberKey, {
      status: "cancelled",
      lastError: null,
      updatedAt: Date.now(),
    });
    // 200 OK, but the envelope carries neither `output` nor `error`. Nothing
    // throws here, so a naive `result.error?.message ?? null` would silently
    // produce `error: null` for a non-completed terminal run.
    resultStatus = 200;
    resultPayload = { run: { id: RUN_ID, status: "cancelled", web_search_agent_id: AGENT_ID } };

    const result = await stub.getRunTypedResult(outcome.fiberKey);
    expect(result.status).toBe("cancelled");
    expect(result.error).not.toBeNull();
    expect(result.error).toMatch(/cancelled/);
    expect(result.result).toMatchObject({ outputType: "unknown", content: null, error: null });
    expect(createCalls).toBe(1); // never a create
  });

  it("surfaces a non-terminal polling diagnostic without fetching a result or creating", async () => {
    const stub = (await getAgentByName(
      typedEnv.NIMBLE_RUN_AGENT,
      "session-result-poll-deadline",
    )) as unknown as NimbleRunAgent;

    const outcome = await stub.startRun({
      nimbleAgentId: AGENT_ID,
      request: { input: "surface the local polling diagnostic" },
    });
    await waitUntil(() => statusCalls >= 1);

    await freezeLedgerRow(stub as unknown as DurableObjectStub, outcome.fiberKey, {
      status: "running",
      lastError: "Polling deadline exceeded",
      updatedAt: Date.now(),
    });

    const result = await stub.getRunTypedResult(outcome.fiberKey);
    expect(resultCalls).toBe(0);
    expect(result.status).toBe("running");
    expect(result.result).toBeNull();
    expect(result.error).toBe("Polling deadline exceeded");
    expect(createCalls).toBe(1);
  });

  it("does not reconcile again within the same poll interval (avoids GET spam on a healthy row)", async () => {
    const stub = (await getAgentByName(
      typedEnv.NIMBLE_RUN_AGENT,
      "session-reconcile-fresh",
    )) as unknown as NimbleRunAgent;

    const outcome = await stub.startRun({
      nimbleAgentId: AGENT_ID,
      request: { input: "fresh row, no reconcile yet" },
    });
    await waitUntil(() => statusCalls >= 1); // drain the real background fiber's own poll first

    await freezeLedgerRow(stub as unknown as DurableObjectStub, outcome.fiberKey, {
      status: "queued",
      pollAttempts: 0,
      updatedAt: Date.now(), // just updated — well within the poll interval
    });

    const statusCallsBefore = statusCalls;
    const status = await stub.getRunLifecycleStatus(outcome.fiberKey);
    expect(status.status).toBe("queued");
    expect(status.pollAttempts).toBe(0);
    expect(statusCalls).toBe(statusCallsBefore); // no reconciliation GET fired yet
  });

  it("allows an explicit safe-read reconciliation inside the interval without creating", async () => {
    const stub = (await getAgentByName(
      typedEnv.NIMBLE_RUN_AGENT,
      "session-reconcile-forced-safe-read",
    )) as unknown as NimbleRunAgent;

    const outcome = await stub.startRun({
      nimbleAgentId: AGENT_ID,
      request: { input: "explicitly reconcile this existing run" },
    });
    await waitUntil(() => statusCalls >= 1);

    await freezeLedgerRow(stub as unknown as DurableObjectStub, outcome.fiberKey, {
      status: "queued",
      pollAttempts: 0,
      updatedAt: Date.now(),
    });

    const statusCallsBefore = statusCalls;
    const status = await stub.reconcileRunLifecycleStatus(outcome.fiberKey);
    expect(statusCalls).toBe(statusCallsBefore + 1);
    expect(status.status).toBe("completed");
    expect(status.pollAttempts).toBe(1);
    expect(createCalls).toBe(1);
  });

  it("never reconciles an override-backed row without the same override re-supplied", async () => {
    const stub = (await getAgentByName(
      typedEnv.NIMBLE_RUN_AGENT,
      "session-reconcile-override",
    )) as unknown as NimbleRunAgent;

    const outcome = await stub.startRun({
      nimbleAgentId: AGENT_ID,
      request: { input: "override-backed, reconcile me only with the key" },
      apiKeyOverride: "user-override-key",
    });
    await waitUntil(() => statusCalls >= 1); // drain the real background fiber's own poll first

    await freezeLedgerRow(stub as unknown as DurableObjectStub, outcome.fiberKey, {
      status: "running",
      pollAttempts: 0,
      updatedAt: Date.now() - 60_000,
    });

    const statusCallsBefore = statusCalls;
    const withoutOverride = await stub.getRunLifecycleStatus(outcome.fiberKey);
    expect(statusCalls).toBe(statusCallsBefore); // no GET without the override
    expect(withoutOverride.status).toBe("running"); // unchanged, still stale

    const withOverride = await stub.getRunLifecycleStatus(outcome.fiberKey, "user-override-key");
    expect(statusCalls).toBe(statusCallsBefore + 1); // exactly one GET, using the override
    expect(withOverride.status).toBe("completed");
    expect(seenAuthHeaders.at(-1)).toBe("Bearer user-override-key");
  });

  it("never reconciles a terminal or recovery-blocked row", async () => {
    const stub = (await getAgentByName(
      typedEnv.NIMBLE_RUN_AGENT,
      "session-reconcile-terminal",
    )) as unknown as NimbleRunAgent;

    const outcome = await stub.startRun({
      nimbleAgentId: AGENT_ID,
      request: { input: "already terminal" },
    });
    await waitUntil(() => statusCalls >= 1); // drain the real background fiber's own poll first

    await freezeLedgerRow(stub as unknown as DurableObjectStub, outcome.fiberKey, {
      status: "failed",
      lastError: "some prior failure",
      updatedAt: Date.now() - 60_000,
    });

    const statusCallsBefore = statusCalls;
    const status = await stub.getRunLifecycleStatus(outcome.fiberKey);
    expect(statusCalls).toBe(statusCallsBefore); // failed is terminal — never reconciled
    expect(status.status).toBe("failed");

    await freezeLedgerRow(stub as unknown as DurableObjectStub, outcome.fiberKey, {
      status: "recovery-blocked",
      updatedAt: Date.now() - 60_000,
    });
    const blocked = await stub.getRunLifecycleStatus(outcome.fiberKey);
    expect(statusCalls).toBe(statusCallsBefore); // recovery-blocked needs explicit resumeWithOverride
    expect(blocked.status).toBe("recovery-blocked");
  });
});
