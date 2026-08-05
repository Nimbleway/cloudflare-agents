import Nimble, { APIConnectionError, APIError } from "@nimble-way/nimble-js";

/**
 * Typed Nimble Agent API V2 adapter.
 *
 * Create uses @nimble-way/nimble-js 1.2.0's generated types with
 * maxRetries=0 for BOTH create routes: `client.agents.runs.create(agentId, ...)`
 * (persistent agent) and `client.agents.run(...)` (agentless, POST
 * /v2/agents/runs — 1.2.0 exposes this as `AgentRunParams`/`AgentRunResponse`).
 * Safe status/result GETs retain the bounded adapter-owned backoff policy.
 */

export const NIMBLE_CLIENT_SOURCE = "cloudflare-agents";
export const DEFAULT_BASE_URL = "https://sdk.nimbleway.com";

export const TERMINAL_STATES = ["completed", "failed", "cancelled"] as const;
export const ACTIVE_STATES = ["queued", "running"] as const;

export type TerminalStatus = (typeof TERMINAL_STATES)[number];
export type ActiveStatus = (typeof ACTIVE_STATES)[number];
/** Statuses this adapter recognizes without inventing semantics for the rest. */
export type KnownRunStatus = ActiveStatus | TerminalStatus;

export type Effort = "low" | "medium" | "high" | "x-high" | "max";
export type SelectableEffort = Effort;
export type UseCase = "research" | "enrichment" | "dataset_building";
export const SELECTABLE_EFFORTS = ["low", "medium", "high", "x-high", "max"] as const;
export const NIMBLE_ENTERPRISE_CONTACT_URL = "https://www.nimbleway.com/contact";

export class GatedFeatureError extends Error {
  readonly feature = "effort:max";
  readonly closestAvailable = "x-high";
  readonly engagementUrl = NIMBLE_ENTERPRISE_CONTACT_URL;

  constructor() {
    super(
      `Nimble Max effort is a coming-soon custom-budget feature. ` +
        `Contact Nimble to enable it: ${NIMBLE_ENTERPRISE_CONTACT_URL}. ` +
        `To continue now, explicitly select x-high; this integration never silently substitutes it.`,
    );
    this.name = "GatedFeatureError";
  }
}

export interface SourceGroup {
  title: string;
  domains: string[];
  order?: number;
}

export interface SourceGuidance {
  allow?: SourceGroup[];
  block?: SourceGroup[];
  prioritize?: string | null;
  avoid?: string | null;
}

export interface CreateRunRequest {
  input: string;
  agent_name?: string | null;
  effort?: SelectableEffort;
  input_data?: Record<string, unknown> | Array<Record<string, unknown>>;
  output_schema?: Record<string, unknown>;
  previous_interaction_id?: string | null;
  skill?: string | null;
  sources?: SourceGuidance | null;
  use_case?: UseCase | null;
  enable_events?: boolean;
}

export interface NimbleRun {
  id: string;
  status: string;
  web_search_agent_id?: string;
  [key: string]: unknown;
}

/**
 * Types below mirror @nimble-way/nimble-js 1.2.0's actual result envelope
 * (resources/agents/runs.d.ts RunResultResponse), NOT a guessed flat shape.
 * A completed run's result is `{ output: { content, trust, type }, run }`;
 * a failed run's result is `{ error: { message, ref_id }, run }`. There is
 * no top-level `text`/`json`/`citations`/`trust`/`claims` — those fields,
 * when present, live under `output` and `output.trust`.
 */
export interface NimbleTrustCitation {
  url: string;
  title?: string | null;
  excerpts?: string[] | null;
}

export interface NimbleTrustClaim {
  confidence: "high" | "medium" | "low" | "pre_existing";
  reasoning: string;
  citations: NimbleTrustCitation[];
  /** Text output: callout marker in the prose. JSON output: JSON path instead. */
  callout?: number;
  path?: string;
}

export interface NimbleTrustSource {
  type: "primary" | "secondary";
  url: string;
  title?: string | null;
}

export interface NimbleTrust {
  confidence: "high" | "medium" | "low" | "pre_existing";
  reasoning: string;
  claims: NimbleTrustClaim[];
  sources: NimbleTrustSource[];
}

/** Normalized, adapter-facing view of a run's result — never the raw envelope shape. */
export interface NimbleResult {
  outputType: "text" | "json" | "unknown";
  /** Prose for text output, structured data for json output. Null for a failed run. */
  content: string | Record<string, unknown> | unknown[] | null;
  /** output.trust when the run completed with trust metadata; null for a failed run. */
  trust: NimbleTrust | null;
  /** Structured error when the run failed; null for a completed run. */
  error: { message: string; refId?: string } | null;
}

/**
 * Normalizes the raw fetched result body into NimbleResult. Handles both
 * documented envelope shapes (`{output,...}` completed, `{error,...}`
 * failed) — matches @nimble-way/nimble-js 1.2.0's RunResultResponse exactly,
 * not a superset guess.
 */
export function normalizeRunResult(raw: unknown): NimbleResult {
  const body = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const output = body.output;
  if (output && typeof output === "object") {
    const outputBody = output as Record<string, unknown>;
    const trustRaw = outputBody.trust;
    const trust =
      trustRaw && typeof trustRaw === "object" ? (trustRaw as unknown as NimbleTrust) : null;
    const outputType =
      outputBody.type === "json" ? "json" : outputBody.type === "text" ? "text" : "unknown";
    return {
      outputType,
      content: (outputBody.content ?? null) as NimbleResult["content"],
      trust,
      error: null,
    };
  }
  const errorRaw = body.error;
  if (errorRaw && typeof errorRaw === "object") {
    const errorBody = errorRaw as Record<string, unknown>;
    if (typeof errorBody.message === "string") {
      return {
        outputType: "unknown",
        content: null,
        trust: null,
        error: {
          message: errorBody.message,
          refId: typeof errorBody.ref_id === "string" ? errorBody.ref_id : undefined,
        },
      };
    }
  }
  return { outputType: "unknown", content: null, trust: null, error: null };
}

export class NimbleAgentAPIError extends Error {
  readonly statusCode: number | undefined;
  readonly refId: string | undefined;
  readonly retryAfterSeconds: number | undefined;

  constructor(
    message: string,
    opts: { statusCode?: number; refId?: string; retryAfterSeconds?: number } = {},
  ) {
    super(message);
    this.name = "NimbleAgentAPIError";
    this.statusCode = opts.statusCode;
    this.refId = opts.refId;
    this.retryAfterSeconds = opts.retryAfterSeconds;
  }
}

/**
 * A write (create) may or may not have reached Nimble before the transport
 * failed, or Nimble returned a 5xx that gives no signal either way. Never
 * retried automatically — the caller must reconcile (list runs for the
 * agent, or GET the run/agent if an id is already known) before deciding
 * whether to submit a new create. Do NOT resubmit blindly.
 */
export class AmbiguousCreateError extends NimbleAgentAPIError {}

const AMBIGUOUS_RECONCILIATION_GUIDANCE =
  "Do not resubmit automatically. Reconcile first: list runs for the agent " +
  "(or GET the run/agent by id if you already captured one) to check whether " +
  "the earlier create actually landed, then decide whether a new create is needed.";

/** Nimble returned 429 on a create. Never retried per contract. */
export class CreateRateLimitedError extends NimbleAgentAPIError {}

export class PollTimeoutError extends NimbleAgentAPIError {}

export interface RetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 500,
  maxDelayMs: 8_000,
};

const AGENT_ID_RE = /^wsa_[A-Za-z0-9_-]+$/;
const RUN_ID_RE = /^task_run_[A-Za-z0-9_-]+$/;

function requireId(value: string, pattern: RegExp, label: string): string {
  if (!pattern.test(value)) {
    throw new Error(`${label} has an unexpected format`);
  }
  return value;
}

function parseRetryAfter(headers: Headers): number | undefined {
  const value = headers.get("Retry-After");
  if (!value) return undefined;
  const asNumber = Number(value);
  if (Number.isFinite(asNumber)) return Math.max(0, asNumber);
  const asDate = Date.parse(value);
  if (Number.isNaN(asDate)) return undefined;
  return Math.max(0, (asDate - Date.now()) / 1000);
}

async function safeErrorFromResponse(response: Response): Promise<NimbleAgentAPIError> {
  let message = `Nimble request failed with HTTP ${response.status}`;
  let refId: string | undefined;
  try {
    const body = (await response.clone().json()) as Record<string, unknown>;
    const candidate = body?.message ?? body?.detail ?? body?.msg;
    if (typeof candidate === "string" && candidate.trim()) {
      message = candidate.trim().slice(0, 500);
    } else if (candidate && typeof candidate === "object") {
      const nested = candidate as Record<string, unknown>;
      const nestedMessage = nested.message ?? nested.detail ?? nested.msg;
      if (typeof nestedMessage === "string" && nestedMessage.trim()) {
        message = nestedMessage.trim().slice(0, 500);
      }
    }
    const candidateRef = body?.ref_id ?? body?.task_id;
    if (typeof candidateRef === "string") refId = candidateRef.slice(0, 200);
  } catch {
    // non-JSON error body; keep the generic message
  }
  return new NimbleAgentAPIError(message, {
    statusCode: response.status,
    refId,
    retryAfterSeconds: parseRetryAfter(response.headers),
  });
}

function sdkErrorMessage(error: APIError): string {
  const body = error.error as Record<string, unknown> | undefined;
  const candidate = body?.message ?? body?.detail ?? body?.msg;
  if (typeof candidate === "string" && candidate.trim()) {
    return candidate.trim().slice(0, 500);
  }
  if (Array.isArray(candidate)) {
    const issues = candidate
      .slice(0, 3)
      .map((issue) => {
        if (!issue || typeof issue !== "object") return null;
        const entry = issue as Record<string, unknown>;
        const location = Array.isArray(entry.loc)
          ? entry.loc.filter((part) => typeof part === "string" || typeof part === "number").join(".")
          : "request";
        const message = typeof entry.msg === "string" ? entry.msg : "validation failed";
        return `${location || "request"}: ${message}`;
      })
      .filter((issue): issue is string => Boolean(issue));
    if (issues.length) return issues.join("; ").slice(0, 500);
  } else if (candidate && typeof candidate === "object") {
    // e.g. daily-limit errors nest the real message: {"message": {"message": "...", "extra": {...}}}
    const nested = candidate as Record<string, unknown>;
    const nestedMessage = nested.message ?? nested.detail ?? nested.msg;
    if (typeof nestedMessage === "string" && nestedMessage.trim()) {
      return nestedMessage.trim().slice(0, 500);
    }
  }
  return `Nimble request failed with HTTP ${error.status ?? "unknown"}`;
}

function sdkErrorRefId(error: APIError): string | undefined {
  const body = error.error as Record<string, unknown> | undefined;
  const candidate = body?.ref_id ?? body?.task_id;
  return typeof candidate === "string" ? candidate.slice(0, 200) : undefined;
}

export interface NimbleClientOptions {
  apiKey: string;
  baseUrl?: string;
  retryPolicy?: RetryPolicy;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Adapter for the three Agent API V2 endpoints this starter uses: SDK-backed
 * typed create, plus adapter-owned status/result GETs.
 *
 * Invariant: create is NEVER retried automatically, regardless of status
 * code (including 429). Safe (GET) reads use bounded backoff honoring
 * Retry-After.
 */
export class NimbleAgentClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly retryPolicy: RetryPolicy;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(opts: NimbleClientOptions) {
    if (!opts.apiKey) throw new Error("apiKey is required");
    this.apiKey = opts.apiKey;
    this.baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
    this.retryPolicy = opts.retryPolicy ?? DEFAULT_RETRY_POLICY;
    // Keep fetch as a bare function call. Some Worker runtimes brand-check
    // the receiver; storing native fetch directly and later invoking it as
    // `this.fetchImpl(...)` supplies NimbleAgentClient as `this`, causing
    // every safe GET to fail while SDK-backed creates still work.
    const fetchImpl = opts.fetchImpl ?? fetch;
    this.fetchImpl = (input, init) => fetchImpl(input, init);
    this.sleep = opts.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      Accept: "application/json",
      "Content-Type": "application/json",
      "X-Client-Source": NIMBLE_CLIENT_SOURCE,
    };
  }

  private backoffMs(attempt: number, retryAfterSeconds: number | undefined): number {
    if (retryAfterSeconds !== undefined) {
      return Math.min(retryAfterSeconds * 1000, this.retryPolicy.maxDelayMs);
    }
    const exponential = this.retryPolicy.baseDelayMs * 2 ** (attempt - 1);
    return Math.min(exponential, this.retryPolicy.maxDelayMs);
  }

  /**
   * POST /v2/agents/{agent_id}/runs (persistent agent) or POST
   * /v2/agents/runs (agentless, server-provisioned agent) — billable,
   * non-idempotent, NEVER retried. Uses @nimble-way/nimble-js 1.2.0's typed
   * `client.agents.runs.create` / `client.agents.run` with a client
   * configured with maxRetries=0.
   *
   * A definite 429 fails immediately with CreateRateLimitedError — never
   * retried. A transport failure or a 5xx (no signal on whether the write
   * landed) fails with AmbiguousCreateError carrying reconciliation
   * guidance — never resubmitted automatically by this adapter.
   */
  async createRun(agentId: string | undefined, body: CreateRunRequest): Promise<NimbleRun> {
    if (agentId) requireId(agentId, AGENT_ID_RE, "agent_id");
    if (!body.input?.trim()) throw new Error("input is required");
    const requestedEffort = (body as { effort?: unknown }).effort;
    if (requestedEffort === "max") {
      // Max remains visible/selectable as a positive product capability, but
      // must stop before this non-idempotent create until access is enabled.
      throw new GatedFeatureError();
    }
    if (
      requestedEffort !== undefined &&
      !(
        typeof requestedEffort === "string" &&
        (SELECTABLE_EFFORTS as readonly string[]).includes(requestedEffort)
      )
    ) {
      throw new Error("effort must be one of: low, medium, high, x-high, max");
    }

    const client = new Nimble({
      apiKey: this.apiKey,
      baseURL: this.baseUrl,
      clientSource: NIMBLE_CLIENT_SOURCE,
      fetch: this.fetchImpl,
      maxRetries: 0,
    });

    let run: NimbleRun;
    try {
      if (agentId) {
        run = (await client.agents.runs.create(agentId, {
          enable_events: false,
          ...body,
        })) as unknown as NimbleRun;
      } else {
        run = (await client.agents.run({
          enable_events: false,
          ...body,
        })) as unknown as NimbleRun;
      }
    } catch (err) {
      // Workerd may move errors across isolate/fiber boundaries where
      // JavaScript prototype identity is not preserved. Retain explicit
      // HTTP errors by shape as well as instanceof so a concrete 429 is
      // never rewritten as an ambiguous transport failure.
      if (
        err instanceof NimbleAgentAPIError ||
        (err instanceof Error &&
          err.name === "NimbleAgentAPIError" &&
          "statusCode" in err)
      ) {
        throw err;
      }
      if (err instanceof APIConnectionError) {
        throw new AmbiguousCreateError(
          `Nimble create-run outcome is unknown after a transport failure. ${AMBIGUOUS_RECONCILIATION_GUIDANCE}`,
          {},
        );
      }
      if (err instanceof APIError) {
        const statusCode = err.status;
        const message = sdkErrorMessage(err);
        const refId = sdkErrorRefId(err);
        const retryAfterSeconds = err.headers ? parseRetryAfter(err.headers) : undefined;
        if (statusCode === 429) {
          throw new CreateRateLimitedError(message, {
            statusCode,
            refId,
            retryAfterSeconds,
          });
        }
        if (statusCode !== undefined && statusCode >= 500) {
          // A 5xx gives no signal on whether the write landed — treat it the
          // same as a transport failure, not a definite rejection.
          throw new AmbiguousCreateError(
            `Nimble create-run returned HTTP ${statusCode} (${message}); outcome is unknown. ${AMBIGUOUS_RECONCILIATION_GUIDANCE}`,
            { statusCode, refId, retryAfterSeconds },
          );
        }
        throw new NimbleAgentAPIError(message, {
          statusCode,
          refId,
          retryAfterSeconds,
        });
      }
      throw new AmbiguousCreateError(
        `Nimble create-run outcome is unknown after a transport failure. ${AMBIGUOUS_RECONCILIATION_GUIDANCE}`,
        {},
      );
    }
    requireId(String(run.id ?? ""), RUN_ID_RE, "created run id");
    const resolvedAgentId = requireId(
      String(run.web_search_agent_id ?? agentId ?? ""),
      AGENT_ID_RE,
      "created agent id",
    );
    if (agentId && resolvedAgentId !== agentId) {
      // Persistent create against a specific agent must never silently
      // resolve to a different agent — that would be an ownership mismatch.
      throw new NimbleAgentAPIError(
        `Nimble create-run returned web_search_agent_id ${resolvedAgentId}, ` +
          `which does not match the requested agent_id ${agentId}`,
      );
    }
    return { ...run };
  }

  /** GET /v2/agents/{agent_id}/runs/{run_id} — safe to retry with backoff. */
  async getRunStatus(agentId: string, runId: string): Promise<NimbleRun> {
    requireId(agentId, AGENT_ID_RE, "agent_id");
    requireId(runId, RUN_ID_RE, "run_id");
    return this.safeGet(`${this.baseUrl}/v2/agents/${agentId}/runs/${runId}`) as Promise<NimbleRun>;
  }

  /**
   * GET /v2/agents/{agent_id}/runs/{run_id}/result — safe to retry with
   * backoff. Normalizes the raw envelope (`{output,...}` / `{error,...}`)
   * into NimbleResult so every caller (agent.ts, the UI) sees a faithful,
   * generic shape instead of guessing at top-level fields.
   */
  async getRunResult(agentId: string, runId: string): Promise<NimbleResult> {
    requireId(agentId, AGENT_ID_RE, "agent_id");
    requireId(runId, RUN_ID_RE, "run_id");
    const raw = await this.safeGet(`${this.baseUrl}/v2/agents/${agentId}/runs/${runId}/result`);
    return normalizeRunResult(raw);
  }

  private async safeGet(url: string): Promise<Record<string, unknown>> {
    let lastError: NimbleAgentAPIError | undefined;
    for (let attempt = 1; attempt <= this.retryPolicy.maxAttempts; attempt++) {
      let response: Response;
      try {
        response = await this.fetchImpl(url, { method: "GET", headers: this.headers() });
      } catch {
        if (attempt === this.retryPolicy.maxAttempts) {
          throw new NimbleAgentAPIError("Nimble request failed after safe retries");
        }
        await this.sleep(this.backoffMs(attempt, undefined));
        continue;
      }
      if (response.ok) {
        return (await response.json()) as Record<string, unknown>;
      }
      const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
      if (retryable && attempt < this.retryPolicy.maxAttempts) {
        lastError = await safeErrorFromResponse(response);
        await this.sleep(this.backoffMs(attempt, lastError.retryAfterSeconds));
        continue;
      }
      throw await safeErrorFromResponse(response);
    }
    throw lastError ?? new NimbleAgentAPIError("Nimble request failed after safe retries");
  }
}

/** Fails closed on any status this adapter does not recognize (no invented semantics). */
export function classifyStatus(status: string): "active" | "terminal" | "unknown" {
  if ((ACTIVE_STATES as readonly string[]).includes(status)) return "active";
  if ((TERMINAL_STATES as readonly string[]).includes(status)) return "terminal";
  return "unknown";
}
