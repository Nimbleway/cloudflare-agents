import { Agent } from "agents";
import type { FiberRecoveryContext, FiberRecoveryResult } from "agents";
import {
  NimbleAgentClient,
  NimbleAgentAPIError,
  AmbiguousCreateError,
  CreateRateLimitedError,
  PollTimeoutError,
  classifyStatus,
  type CreateRunRequest,
  type NimbleResult,
} from "./nimble-client";

export interface Env {
  NIMBLE_RUN_AGENT: DurableObjectNamespace<NimbleRunAgent>;
  /** Protected server-secret fallback; overridden per-request by an ephemeral user key. */
  NIMBLE_API_KEY?: string;
  NIMBLE_BASE_URL?: string;
  /** Backend Agent API V2 status interval. Defaults to 10s; production values must be >=10s. */
  NIMBLE_POLL_INTERVAL_MS?: string;
  /** Test-only escape hatch for zero/short polling intervals. Never set in production. */
  NIMBLE_TEST_ALLOW_SHORT_POLL_INTERVALS?: string;
}

export interface RunLedgerRow {
  agentId: string;
  runId: string | null;
  status: string;
  createdAt: number;
  updatedAt: number;
  pollAttempts: number;
  fiberIdempotencyKey: string;
  recoveredCount: number;
  lastError: string | null;
  /** True if this run was created/polled using an ephemeral per-user key override. */
  usedOverrideKey: boolean;
}

export interface AgentState {
  runs: Record<string, RunLedgerRow>;
}

interface StartFiberSnapshot {
  nimbleAgentId: string;
  runId: string | null;
  /**
   * Whether the create used an ephemeral per-user API key override. The
   * override itself is NEVER stashed/persisted (it must not survive an
   * eviction) — only this boolean, so recovery can fail closed instead of
   * silently re-authenticating as a different account.
   */
  usedOverrideKey: boolean;
}

export interface StartRunInput {
  /** Omit to use POST /v2/agents/runs and let Nimble provision the WSA. */
  nimbleAgentId?: string;
  request: CreateRunRequest;
  /** Ephemeral per-user API key override; falls back to env.NIMBLE_API_KEY. */
  apiKeyOverride?: string;
}

export interface StartRunOutcome {
  fiberKey: string;
  accepted: boolean;
  runId: string | null;
  status: string;
}

export interface StatusOutcome {
  fiberKey: string;
  runId: string | null;
  /** Nimble's durable web_search_agent_id (wsa_...), distinct from runId (task_run_...). */
  agentId: string | null;
  status: string;
  pollAttempts: number;
  recoveredCount: number;
  lastError: string | null;
}

export interface ResultOutcome {
  fiberKey: string;
  runId: string | null;
  /** Nimble's durable web_search_agent_id (wsa_...), distinct from runId (task_run_...). */
  agentId: string | null;
  status: string;
  result: NimbleResult | null;
  error: string | null;
}

export const DEFAULT_POLL_INTERVAL_MS = 10_000;
const POLL_DEADLINE_MS = 5 * 60_000;

export function resolvePollIntervalMs(env: Pick<
  Env,
  "NIMBLE_POLL_INTERVAL_MS" | "NIMBLE_TEST_ALLOW_SHORT_POLL_INTERVALS"
>): number {
  const raw = env.NIMBLE_POLL_INTERVAL_MS;
  if (raw === undefined || raw === "") return DEFAULT_POLL_INTERVAL_MS;

  const intervalMs = Number(raw);
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 0) {
    throw new Error("NIMBLE_POLL_INTERVAL_MS must be a non-negative integer");
  }
  if (
    intervalMs < DEFAULT_POLL_INTERVAL_MS &&
    env.NIMBLE_TEST_ALLOW_SHORT_POLL_INTERVALS !== "true"
  ) {
    throw new Error(
      "NIMBLE_POLL_INTERVAL_MS values below 10000 are test-only; " +
        "set NIMBLE_TEST_ALLOW_SHORT_POLL_INTERVALS=true only in tests",
    );
  }
  return intervalMs;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalize(nested)]),
    );
  }
  return value;
}

/**
 * Deterministic idempotency key: the SAME full create request (every field
 * that affects what Nimble is billed to do — input, agent_name, effort,
 * enable_events, input_data, output_schema, previous_interaction_id, skill,
 * sources, and use_case) never issues a second create.
 *
 * Design notes:
 * - Covers the FULL request, not a subset. Two requests differing only in
 *   `effort` or `enable_events` are billed differently by Nimble and must
 *   dedupe to DIFFERENT keys, not collapse into "same run".
 * - Uses SHA-256 (Web Crypto, available in workerd) over a canonical JSON
 *   encoding, not a 32-bit rolling hash — a 32-bit hash has a ~50% collision
 *   chance past ~77k distinct requests (birthday bound) sharing one Durable
 *   Object's ledger, which is within reach for a long-lived agent session
 *   and would silently merge two unrelated runs into one idempotency key.
 *   SHA-256's 256-bit space makes accidental collision practically zero.
 * - Deliberately excludes `apiKeyOverride`: the idempotency key identifies
 *   "what work", not "which credential authorized it" — the same task run
 *   twice with two different per-user keys should still dedupe (whoever
 *   asked first wins the create; see "Recovery for override-backed runs"
 *   for how the credential itself is handled separately and never persisted).
 */
export async function deriveFiberKey(
  nimbleAgentId: string | undefined,
  request: CreateRunRequest,
): Promise<string> {
  const canonical = JSON.stringify(
    canonicalize({
      agent_id: nimbleAgentId ?? null,
      input: request.input,
      agent_name: request.agent_name ?? null,
      effort: request.effort ?? null,
      enable_events: request.enable_events ?? false,
      input_data: request.input_data ?? null,
      output_schema: request.output_schema ?? null,
      previous_interaction_id: request.previous_interaction_id ?? null,
      skill: request.skill ?? null,
      sources: request.sources ?? null,
      use_case: request.use_case ?? null,
    }),
  );
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  const hex = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `nimble-run:${nimbleAgentId ?? "generated"}:${hex}`;
}

/**
 * Durable Object-backed Agent owning one Nimble Agent API V2 run lifecycle
 * per fiber key. Uses agents@0.20.0's startFiber() for durable acceptance,
 * dedupe, and crash recovery.
 */
export class NimbleRunAgent extends Agent<Env, AgentState> {
  initialState: AgentState = { runs: {} };

  private client(apiKeyOverride?: string): NimbleAgentClient {
    const apiKey = apiKeyOverride || this.env.NIMBLE_API_KEY;
    if (!apiKey) {
      throw new Error(
        "No Nimble API key available: no per-user override and NIMBLE_API_KEY is unset",
      );
    }
    return new NimbleAgentClient({
      apiKey,
      baseUrl: this.env.NIMBLE_BASE_URL,
    });
  }

  private upsertLedger(fiberKey: string, patch: Partial<RunLedgerRow>): void {
    const now = Date.now();
    const existing = this.state.runs[fiberKey];
    const row: RunLedgerRow = {
      agentId: existing?.agentId ?? "",
      runId: existing?.runId ?? null,
      status: existing?.status ?? "queued",
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      pollAttempts: existing?.pollAttempts ?? 0,
      fiberIdempotencyKey: fiberKey,
      recoveredCount: existing?.recoveredCount ?? 0,
      lastError: existing?.lastError ?? null,
      usedOverrideKey: existing?.usedOverrideKey ?? false,
      ...patch,
    };
    this.setState({ runs: { ...this.state.runs, [fiberKey]: row } });
  }

  /**
   * "start" tool. Never retries the create; deduplicates via startFiber's
   * idempotencyKey so a duplicate call with the same (agent_id, input) joins
   * the existing run instead of billing a second create.
   */
  async startRun(input: StartRunInput): Promise<StartRunOutcome> {
    const fiberKey = await deriveFiberKey(input.nimbleAgentId, input.request);
    const usedOverrideKey = Boolean(input.apiKeyOverride);
    // startFiber performs the create-side idempotency decision below. Do not
    // rewrite an existing ledger row before that decision: a duplicate start
    // must preserve terminal state and, critically, the credential provenance
    // established by the first accepted request.
    if (!this.state.runs[fiberKey]) {
      this.upsertLedger(fiberKey, {
        agentId: input.nimbleAgentId ?? "",
        status: "queued",
        usedOverrideKey,
      });
    }

    const receipt = await this.startFiber(
      fiberKey,
      async (ctx) => {
        const client = this.client(input.apiKeyOverride);
        let run;
        try {
          run = await client.createRun(input.nimbleAgentId, input.request);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          this.upsertLedger(fiberKey, { status: "failed", lastError: message });
          throw err;
        }
        // Stash immediately after create succeeds, before the first poll,
        // so a mid-poll eviction never loses the run id (never re-creates).
        // The API key itself is NEVER stashed — only whether one was used —
        // so recovery cannot resurrect or substitute a credential.
        const resolvedAgentId = String(run.web_search_agent_id ?? input.nimbleAgentId ?? "");
        const snapshot: StartFiberSnapshot = {
          nimbleAgentId: resolvedAgentId,
          runId: run.id,
          usedOverrideKey,
        };
        ctx.stash(snapshot);
        this.upsertLedger(fiberKey, {
          agentId: resolvedAgentId,
          runId: run.id,
          status: run.status,
        });

        await this.pollUntilTerminal(fiberKey, resolvedAgentId, run.id, ctx.signal, input.apiKeyOverride);
      },
      { idempotencyKey: fiberKey, metadata: { nimbleAgentId: input.nimbleAgentId ?? "generated" } },
    );

    const row = this.state.runs[fiberKey];
    return {
      fiberKey,
      accepted: receipt.accepted,
      runId: row?.runId ?? null,
      status: row?.status ?? "queued",
    };
  }

  private async pollUntilTerminal(
    fiberKey: string,
    nimbleAgentId: string,
    runId: string,
    signal: AbortSignal,
    apiKeyOverride?: string,
  ): Promise<void> {
    const client = this.client(apiKeyOverride);
    const deadline = Date.now() + POLL_DEADLINE_MS;
    const pollIntervalMs = resolvePollIntervalMs(this.env);
    while (!signal.aborted) {
      const run = await client.getRunStatus(nimbleAgentId, runId);
      const status = String(run.status);
      const kind = classifyStatus(status);
      const attempts = (this.state.runs[fiberKey]?.pollAttempts ?? 0) + 1;
      this.upsertLedger(fiberKey, { status, pollAttempts: attempts, lastError: null });

      if (kind === "terminal") return;
      if (kind === "unknown") {
        this.upsertLedger(fiberKey, { status: "failed", lastError: `Unknown run status: ${status}` });
        throw new NimbleAgentAPIError(`Unknown run status: ${status}`, { refId: runId });
      }
      if (Date.now() > deadline) {
        // The adapter's polling budget expiring is not a provider terminal
        // failure. Preserve the last provider status so a later status/result
        // read can reconcile this durable run with a safe GET. Marking it
        // "failed" here would make classifyStatus() treat the row as terminal
        // and permanently disable that resumability path.
        this.upsertLedger(fiberKey, { lastError: "Polling deadline exceeded" });
        throw new PollTimeoutError("Timed out waiting for a terminal Nimble run status", {
          refId: runId,
        });
      }
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
  }

  /**
   * Self-healing reconciliation for a non-terminal ledger row. The
   * background fiber's own poll loop (pollUntilTerminal) waits on a plain
   * `await new Promise(setTimeout(...))`, which does NOT survive a Durable
   * Object eviction/hibernation — unlike a DO alarm, nothing wakes the
   * isolate to resolve that timer, so if the fiber is evicted while
   * suspended there, the whole callback is gone and onFiberRecovered's
   * automatic resume is the only thing that can restart it. If that SDK
   * hook does not fire (or fires without effect) for some reason, the
   * ledger is otherwise stuck forever with a valid runId and no way
   * forward. This is a general, run-agnostic repair: any time a caller
   * reads status/result for a row that looks stale, do ONE safe GET
   * ourselves to bring the ledger current — never a create, and only ever
   * a GET the caller is already authorized to make.
   *
   * Skips (leaves the ledger untouched) when: there is no runId yet, the
   * row is already terminal, the row is "recovery-blocked" (that state
   * requires the explicit resumeWithOverride() flow, not a background
   * reconcile), the row needs an override the caller did not supply, or
   * less than one poll interval has passed since the last update (avoids
   * turning every status read into an extra live GET for a row that is
   * still being actively polled by a healthy fiber).
   */
  private async reconcileIfStale(
    fiberKey: string,
    apiKeyOverride?: string,
    forceSafeRead = false,
  ): Promise<void> {
    const row = this.state.runs[fiberKey];
    if (!row?.runId) return;
    if (classifyStatus(row.status) === "terminal") return;
    if (row.status === "recovery-blocked") return;
    if (row.usedOverrideKey && !apiKeyOverride) return;

    const pollIntervalMs = resolvePollIntervalMs(this.env);
    if (!forceSafeRead && Date.now() - row.updatedAt < pollIntervalMs) return;

    try {
      const client = this.client(apiKeyOverride);
      const run = await client.getRunStatus(row.agentId, row.runId);
      const status = String(run.status);
      const kind = classifyStatus(status);
      const attempts = (this.state.runs[fiberKey]?.pollAttempts ?? 0) + 1;
      if (kind === "unknown") {
        this.upsertLedger(fiberKey, {
          status: "failed",
          pollAttempts: attempts,
          lastError: `Unknown run status: ${status}`,
        });
        return;
      }
      this.upsertLedger(fiberKey, { status, pollAttempts: attempts, lastError: null });
    } catch (err) {
      // A reconciliation GET failing does not fail the caller's status/result
      // read — it just leaves the ledger at its last-known state, recorded
      // for visibility.
      const message = err instanceof Error ? err.message : String(err);
      this.upsertLedger(fiberKey, { lastError: message });
    }
  }

  /**
   * Called automatically by the SDK on the next activation if this Agent
   * was evicted mid-fiber. Resumes polling from the stashed run id — never
   * re-issues a create.
   */
  async onFiberRecovered(ctx: FiberRecoveryContext): Promise<void | FiberRecoveryResult> {
    const snapshot = ctx.snapshot as StartFiberSnapshot | null;
    const fiberKey = ctx.idempotencyKey ?? ctx.name;
    this.upsertLedger(fiberKey, {
      recoveredCount: (this.state.runs[fiberKey]?.recoveredCount ?? 0) + 1,
    });

    if (!snapshot?.runId) {
      // Evicted before the create's response was ever stashed. We do NOT
      // know whether the create reached Nimble — per contract, we do not
      // retry it. Leave the fiber interrupted for operator inspection.
      this.upsertLedger(fiberKey, {
        status: "failed",
        lastError: "Recovered before create was confirmed; not retried (ambiguous write)",
      });
      return { status: "error", error: "create-outcome-unknown-not-retried" };
    }

    // Fail-closed recovery for override-backed runs: the ephemeral per-user
    // key was never stashed/persisted (by design — see StartFiberSnapshot),
    // so it does not survive an eviction. Silently resuming with
    // env.NIMBLE_API_KEY (the server fallback) would poll/fetch this run
    // under a DIFFERENT account than the one that authorized it — a
    // cross-account credential switch. Instead: stop, leave the run's
    // ledger status as "recovery-blocked", and require the caller to
    // re-supply the same override explicitly (see getRunLifecycleStatus /
    // getRunTypedResult, which independently refuse to silently fall back
    // for a usedOverrideKey run). We never retry the create either way.
    if (snapshot.usedOverrideKey) {
      this.upsertLedger(fiberKey, {
        status: "recovery-blocked",
        lastError:
          "Recovery blocked: this run was authorized with a per-user API key override that " +
          "is never persisted and cannot be safely re-supplied automatically. The server " +
          "fallback key was deliberately NOT used to avoid a cross-account credential switch. " +
          "Re-supply the same override via the result/status tool to continue.",
      });
      return {
        status: "error",
        error: "override-key-recovery-blocked-fail-closed",
        snapshot,
      };
    }

    try {
      const controller = new AbortController();
      await this.pollUntilTerminal(
        fiberKey,
        snapshot.nimbleAgentId,
        snapshot.runId,
        controller.signal,
      );
      return { status: "completed", snapshot };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { status: "error", error: message, snapshot };
    }
  }

  /**
   * "status" tool. `apiKeyOverride` is optional and only used to reconcile
   * an override-backed row that has gone stale (see reconcileIfStale) — it
   * is never required just to read the ledger's last-known state.
   */
  async getRunLifecycleStatus(
    fiberKey: string,
    apiKeyOverride?: string,
  ): Promise<StatusOutcome> {
    await this.reconcileIfStale(fiberKey, apiKeyOverride);
    const inspected = await this.inspectFiberByKey(fiberKey);
    const row = this.state.runs[fiberKey];
    return {
      fiberKey,
      runId: row?.runId ?? null,
      agentId: row?.agentId || null,
      status: row?.status ?? inspected?.status ?? "unknown",
      pollAttempts: row?.pollAttempts ?? 0,
      recoveredCount: row?.recoveredCount ?? 0,
      lastError: row?.lastError ?? null,
    };
  }

  /**
   * Explicit operator recovery for an already-created run. Performs one
   * safe provider GET regardless of the ordinary poll throttle, then returns
   * the durable ledger state. This can never issue a create.
   */
  async reconcileRunLifecycleStatus(
    fiberKey: string,
    apiKeyOverride?: string,
  ): Promise<StatusOutcome> {
    await this.reconcileIfStale(fiberKey, apiKeyOverride, true);
    return this.getRunLifecycleStatus(fiberKey, apiKeyOverride);
  }

  /** "result" tool. Fetches the typed Nimble result once the run is terminal. */
  async getRunTypedResult(
    fiberKey: string,
    apiKeyOverride?: string,
  ): Promise<ResultOutcome> {
    await this.reconcileIfStale(fiberKey, apiKeyOverride);
    const row = this.state.runs[fiberKey];
    if (!row?.runId) {
      return {
        fiberKey,
        runId: null,
        agentId: row?.agentId || null,
        status: row?.status ?? "unknown",
        result: null,
        error: row?.lastError ?? "no run id yet",
      };
    }
    // Never silently switch credentials: a run created under a per-user
    // override must be read back with the SAME override supplied again by
    // the caller, not the server fallback key. This applies independent of
    // (and in addition to) the fail-closed recovery hook above — it also
    // protects a run that is still "running" and simply hasn't been evicted.
    if (row.usedOverrideKey && !apiKeyOverride) {
      return {
        fiberKey,
        runId: row.runId,
        agentId: row.agentId || null,
        status: row.status,
        result: null,
        error:
          "This run was created with a per-user API key override; re-supply the same " +
          "override to read its result (the server fallback key is never substituted).",
      };
    }
    if (row.status !== "completed") {
      return {
        fiberKey,
        runId: row.runId,
        agentId: row.agentId || null,
        status: row.status,
        result: null,
        error: row.status === "failed" ? row.lastError : null,
      };
    }
    const client = this.client(apiKeyOverride);
    const result = await client.getRunResult(row.agentId, row.runId);
    return { fiberKey, runId: row.runId, agentId: row.agentId || null, status: row.status, result, error: null };
  }

  /**
   * Resumes a "recovery-blocked" override-backed run once the caller
   * re-supplies the same (or an equivalently authorized) API key. Never
   * used to retry the create — only to resume polling an already-created
   * run. See onFiberRecovered's fail-closed handling above.
   */
  async resumeWithOverride(fiberKey: string, apiKeyOverride: string): Promise<StatusOutcome> {
    const row = this.state.runs[fiberKey];
    if (!row?.runId) {
      throw new Error("No run to resume for this fiberKey");
    }
    if (row.status !== "recovery-blocked") {
      return this.getRunLifecycleStatus(fiberKey);
    }
    this.upsertLedger(fiberKey, { status: "running", lastError: null });
    const controller = new AbortController();
    await this.pollUntilTerminal(fiberKey, row.agentId, row.runId, controller.signal, apiKeyOverride);
    return this.getRunLifecycleStatus(fiberKey);
  }
}

export { AmbiguousCreateError, CreateRateLimitedError };
