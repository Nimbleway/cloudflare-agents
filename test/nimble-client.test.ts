import { describe, expect, it, vi } from "vitest";
import {
  NimbleAgentClient,
  AmbiguousCreateError,
  CreateRateLimitedError,
  NimbleAgentAPIError,
  classifyStatus,
  type CreateRunRequest,
} from "../src/nimble-client";

const AGENT_ID = "wsa_abc123";
const RUN_ID = "task_run_xyz789";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fakeFetch(handler: (url: string, init: RequestInit) => Response): any {
  return vi.fn(async (input: unknown, init?: RequestInit) => {
    if (input instanceof Request) {
      const body =
        input.method === "GET" || input.method === "HEAD" ? undefined : await input.clone().text();
      return handler(input.url, {
        method: input.method,
        headers: input.headers,
        body,
      });
    }
    return handler(String(input), init ?? {});
  });
}

function noopSleep() {
  return vi.fn(async () => {});
}

describe("NimbleAgentClient — X-Client-Source", () => {
  it("sends the exact literal X-Client-Source on createRun", async () => {
    let seenHeaders: Headers | undefined;
    const fetchImpl = fakeFetch((_url, init) => {
      seenHeaders = new Headers(init.headers as HeadersInit);
      return new Response(JSON.stringify({ id: RUN_ID, status: "queued" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const client = new NimbleAgentClient({ apiKey: "k", fetchImpl });
    await client.createRun(AGENT_ID, { input: "do the thing" });
    expect(seenHeaders?.get("X-Client-Source")).toBe("cloudflare-agents");
  });

  it("sends the exact literal X-Client-Source on getRunStatus", async () => {
    let seenHeaders: Headers | undefined;
    const fetchImpl = fakeFetch((_url, init) => {
      seenHeaders = new Headers(init.headers as HeadersInit);
      return new Response(JSON.stringify({ id: RUN_ID, status: "completed" }), { status: 200 });
    });
    const client = new NimbleAgentClient({ apiKey: "k", fetchImpl, sleep: noopSleep() });
    await client.getRunStatus(AGENT_ID, RUN_ID);
    expect(seenHeaders?.get("X-Client-Source")).toBe("cloudflare-agents");
  });

  it("sends the exact literal X-Client-Source on getRunResult", async () => {
    let seenHeaders: Headers | undefined;
    const fetchImpl = fakeFetch((_url, init) => {
      seenHeaders = new Headers(init.headers as HeadersInit);
      return new Response(JSON.stringify({ text: "ok" }), { status: 200 });
    });
    const client = new NimbleAgentClient({ apiKey: "k", fetchImpl, sleep: noopSleep() });
    await client.getRunResult(AGENT_ID, RUN_ID);
    expect(seenHeaders?.get("X-Client-Source")).toBe("cloudflare-agents");
  });
});

describe("NimbleAgentClient — never retries create", () => {
  it("A03: never retries a create on transport failure (throws AmbiguousCreateError once)", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("network down");
    });
    const client = new NimbleAgentClient({ apiKey: "k", fetchImpl });
    await expect(client.createRun(AGENT_ID, { input: "x" })).rejects.toBeInstanceOf(
      AmbiguousCreateError,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("stops immediately on 429 create — no retry, no backoff sleep", async () => {
    const fetchImpl = fakeFetch(
      () =>
        new Response(JSON.stringify({ message: "rate limited" }), {
          status: 429,
          headers: { "Retry-After": "5" },
        }),
    );
    const sleep = noopSleep();
    const client = new NimbleAgentClient({ apiKey: "k", fetchImpl, sleep });
    await expect(client.createRun(AGENT_ID, { input: "x" })).rejects.toBeInstanceOf(
      CreateRateLimitedError,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("preserves the nested daily-limit message returned by Agent API V2", async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json(
        {
          message: {
            message: "Maximum 10 task runs per day exceeded",
            extra: { error_type: "task_run_limit_exceeded" },
          },
        },
        { status: 429 },
      ),
    );
    const client = new NimbleAgentClient({ apiKey: "test-key", fetchImpl });

    await expect(client.createRun(undefined, { input: "bounded test" })).rejects.toMatchObject({
      message: "Maximum 10 task runs per day exceeded",
      statusCode: 429,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("never retries create on 500 either", async () => {
    const fetchImpl = fakeFetch(() => new Response("boom", { status: 500 }));
    const client = new NimbleAgentClient({ apiKey: "k", fetchImpl, sleep: noopSleep() });
    await expect(client.createRun(AGENT_ID, { input: "x" })).rejects.toBeInstanceOf(
      NimbleAgentAPIError,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("NimbleAgentClient — bounded backoff on safe reads only", () => {
  it("retries a GET on 429 honoring Retry-After, then succeeds", async () => {
    let call = 0;
    const fetchImpl = fakeFetch(() => {
      call += 1;
      if (call === 1) {
        return new Response("rate limited", { status: 429, headers: { "Retry-After": "0.01" } });
      }
      return new Response(JSON.stringify({ id: RUN_ID, status: "running" }), { status: 200 });
    });
    const sleep = vi.fn(async () => {});
    const client = new NimbleAgentClient({ apiKey: "k", fetchImpl, sleep });
    const run = await client.getRunStatus(AGENT_ID, RUN_ID);
    expect(run.status).toBe("running");
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it("gives up after maxAttempts on a persistently failing GET", async () => {
    const fetchImpl = fakeFetch(() => new Response("down", { status: 503 }));
    const client = new NimbleAgentClient({
      apiKey: "k",
      fetchImpl,
      sleep: noopSleep(),
      retryPolicy: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 2 },
    });
    await expect(client.getRunStatus(AGENT_ID, RUN_ID)).rejects.toBeInstanceOf(NimbleAgentAPIError);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe("classifyStatus — deterministic status coverage, fails closed on unknown", () => {
  it.each([
    ["queued", "active"],
    ["running", "active"],
    ["completed", "terminal"],
    ["failed", "terminal"],
    ["cancelled", "terminal"],
  ] as const)("classifies %s as %s", (status, expected) => {
    expect(classifyStatus(status)).toBe(expected);
  });

  it.each(["not-ready", "timeout", "abort", "processing", ""])(
    "fails closed (unknown) on unrecognized status %s — no invented semantics",
    (status) => {
      expect(classifyStatus(status)).toBe("unknown");
    },
  );
});

describe("NimbleAgentClient — observed 409/422 on create surface as sanitized errors, not retried", () => {
  it("409 create fails without retry", async () => {
    const fetchImpl = fakeFetch(
      () => new Response(JSON.stringify({ message: "conflict" }), { status: 409 }),
    );
    const client = new NimbleAgentClient({ apiKey: "k", fetchImpl });
    await expect(client.createRun(AGENT_ID, { input: "x" })).rejects.toMatchObject({
      statusCode: 409,
      message: "conflict",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("422 create fails without retry", async () => {
    const fetchImpl = fakeFetch(
      () => new Response(JSON.stringify({ message: "invalid input" }), { status: 422 }),
    );
    const client = new NimbleAgentClient({ apiKey: "k", fetchImpl });
    await expect(client.createRun(AGENT_ID, { input: "x" })).rejects.toMatchObject({
      statusCode: 422,
      message: "invalid input",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("422 structured validation details are reduced to safe location/message text", async () => {
    const fetchImpl = fakeFetch(
      () =>
        new Response(
          JSON.stringify({
            detail: [
              {
                loc: ["body", "input"],
                msg: "String should have at most 2000 characters",
                type: "string_too_long",
                input: "must never be reflected",
              },
            ],
          }),
          { status: 422, headers: { "content-type": "application/json" } },
        ),
    );
    const client = new NimbleAgentClient({ apiKey: "k", fetchImpl });
    await expect(client.createRun(AGENT_ID, { input: "x" })).rejects.toMatchObject({
      statusCode: 422,
      message: "body.input: String should have at most 2000 characters",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("NimbleAgentClient — getRunResult normalizes the real Agent API V2 envelope", () => {
  it("normalizes a completed text-output run: output.content + output.trust, not a top-level guess", async () => {
    // Matches @nimble-way/nimble-js 1.2.0's RunResultResponse.TaskRunResultPublicV2 exactly —
    // the real envelope nests content/trust under `output`, never at the top level.
    const payload = {
      run: { id: RUN_ID, status: "completed", web_search_agent_id: AGENT_ID },
      output: {
        type: "text",
        content: "Example synthetic answer text for a test fixture [1][2].",
        trust: {
          confidence: "high",
          reasoning: "Two independent official sources corroborate the answer.",
          claims: [
            {
              callout: 1,
              confidence: "high",
              reasoning: "Directly stated on the official page.",
              citations: [{ url: "https://example.com/a", title: "Example A" }],
            },
            {
              callout: 2,
              confidence: "medium",
              reasoning: "Corroborated by a secondary source.",
              citations: [{ url: "https://example.com/b", title: "Example B" }],
            },
          ],
          sources: [
            { type: "primary", url: "https://example.com/a", title: "Example A" },
            { type: "secondary", url: "https://example.com/b", title: "Example B" },
          ],
        },
      },
    };
    const fetchImpl = fakeFetch(() => new Response(JSON.stringify(payload), { status: 200 }));
    const client = new NimbleAgentClient({ apiKey: "k", fetchImpl, sleep: noopSleep() });
    const result = await client.getRunResult(AGENT_ID, RUN_ID);

    expect(result.outputType).toBe("text");
    expect(result.content).toBe(payload.output.content);
    expect(result.error).toBeNull();
    expect(result.trust?.confidence).toBe("high");
    expect(result.trust?.claims).toHaveLength(2);
    expect(result.trust?.sources).toHaveLength(2);
    expect(result.trust?.sources[0]).toMatchObject({ type: "primary", url: "https://example.com/a" });
  });

  it("normalizes a completed json-output run's structured content", async () => {
    const payload = {
      run: { id: RUN_ID, status: "completed", web_search_agent_id: AGENT_ID },
      output: {
        type: "json",
        content: { company: "Example Co", founded: 2020 },
        trust: {
          confidence: "medium",
          reasoning: "Single source.",
          claims: [
            {
              path: "$.founded",
              confidence: "medium",
              reasoning: "Stated once, not cross-checked.",
              citations: [{ url: "https://example.com/about" }],
            },
          ],
          sources: [{ type: "primary", url: "https://example.com/about" }],
        },
      },
    };
    const fetchImpl = fakeFetch(() => new Response(JSON.stringify(payload), { status: 200 }));
    const client = new NimbleAgentClient({ apiKey: "k", fetchImpl, sleep: noopSleep() });
    const result = await client.getRunResult(AGENT_ID, RUN_ID);

    expect(result.outputType).toBe("json");
    expect(result.content).toMatchObject({ company: "Example Co", founded: 2020 });
    expect(result.trust?.claims[0]).toMatchObject({ path: "$.founded" });
  });

  it("normalizes a failed run's structured error, never fabricating content or trust", async () => {
    const payload = {
      run: { id: RUN_ID, status: "failed", web_search_agent_id: AGENT_ID },
      error: { message: "No sources could be retrieved.", ref_id: RUN_ID },
    };
    const fetchImpl = fakeFetch(() => new Response(JSON.stringify(payload), { status: 200 }));
    const client = new NimbleAgentClient({ apiKey: "k", fetchImpl, sleep: noopSleep() });
    const result = await client.getRunResult(AGENT_ID, RUN_ID);

    expect(result.outputType).toBe("unknown");
    expect(result.content).toBeNull();
    expect(result.trust).toBeNull();
    expect(result.error).toMatchObject({ message: "No sources could be retrieved.", refId: RUN_ID });
  });

  it("normalizes an unrecognized/empty body to a safe empty shape instead of throwing", async () => {
    const fetchImpl = fakeFetch(() => new Response(JSON.stringify({}), { status: 200 }));
    const client = new NimbleAgentClient({ apiKey: "k", fetchImpl, sleep: noopSleep() });
    const result = await client.getRunResult(AGENT_ID, RUN_ID);

    expect(result).toEqual({ outputType: "unknown", content: null, trust: null, error: null });
  });
});

describe("NimbleAgentClient — Worker-safe fetch invocation", () => {
  it("invokes a receiver-sensitive fetch implementation as a bare function", async () => {
    const fetchImpl = function (this: unknown) {
      expect(this).toBeUndefined();
      return Promise.resolve(
        new Response(
          JSON.stringify({
            id: RUN_ID,
            web_search_agent_id: AGENT_ID,
            status: "completed",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    } as typeof fetch;

    const client = new NimbleAgentClient({ apiKey: "k", fetchImpl, sleep: noopSleep() });
    const run = await client.getRunStatus(AGENT_ID, RUN_ID);
    expect(run.status).toBe("completed");
  });
});

describe("NimbleAgentClient — request contract", () => {
  it("creates a server-provisioned WSA when agent_id is omitted", async () => {
    let seenUrl = "";
    let seenBody: unknown;
    const fetchImpl = fakeFetch((url, init) => {
      seenUrl = url;
      seenBody = JSON.parse(String(init.body));
      return new Response(
        JSON.stringify({
          id: RUN_ID,
          web_search_agent_id: AGENT_ID,
          status: "queued",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const client = new NimbleAgentClient({ apiKey: "k", fetchImpl });
    const run = await client.createRun(undefined, {
      input: "Build a dataset",
      input_data: [{ company: "Nimble" }],
      output_schema: { type: "object" },
      skill: "Use official sources",
      use_case: "dataset_building",
    });
    expect(seenUrl).toBe("https://sdk.nimbleway.com/v2/agents/runs");
    expect(seenBody).toMatchObject({
      input: "Build a dataset",
      input_data: [{ company: "Nimble" }],
      output_schema: { type: "object" },
      skill: "Use official sources",
      use_case: "dataset_building",
    });
    expect(run.web_search_agent_id).toBe(AGENT_ID);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("omits effort when the caller did not select one", async () => {
    let seenUrl = "";
    let seenBody: unknown;
    const fetchImpl = fakeFetch((url, init) => {
      seenUrl = url;
      seenBody = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ id: RUN_ID, status: "queued" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const client = new NimbleAgentClient({ apiKey: "k", fetchImpl });
    await client.createRun(AGENT_ID, {
      input: "task",
      sources: { allow: [{ title: "Official", domains: ["example.com"] }] },
    });
    expect(seenUrl).toBe(`https://sdk.nimbleway.com/v2/agents/${AGENT_ID}/runs`);
    expect(seenBody).toMatchObject({
      input: "task",
      sources: { allow: [{ title: "Official", domains: ["example.com"] }] },
      enable_events: false,
    });
    expect(seenBody).not.toHaveProperty("effort");
  });

  it("serializes explicit effort and 1.2.0 typed agent_name, skill, and use_case fields", async () => {
    let seenBody: unknown;
    const fetchImpl = fakeFetch((_url, init) => {
      seenBody = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ id: RUN_ID, status: "queued" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const client = new NimbleAgentClient({ apiKey: "k", fetchImpl });
    await client.createRun(AGENT_ID, {
      input: "task",
      agent_name: "Research Analyst",
      effort: "medium",
      skill: "Compare official sources",
      use_case: "research",
    });
    expect(seenBody).toMatchObject({
      agent_name: "Research Analyst",
      effort: "medium",
      skill: "Compare official sources",
      use_case: "research",
    });
  });

  it("agentless route (client.agents.run) serializes the same 1.2.0 typed agent_name, skill, and use_case fields", async () => {
    let seenUrl = "";
    let seenBody: unknown;
    const fetchImpl = fakeFetch((url, init) => {
      seenUrl = url;
      seenBody = JSON.parse(String(init.body));
      return new Response(
        JSON.stringify({ id: RUN_ID, web_search_agent_id: AGENT_ID, status: "queued" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const client = new NimbleAgentClient({ apiKey: "k", fetchImpl });
    await client.createRun(undefined, {
      input: "task",
      agent_name: "Research Analyst",
      effort: "medium",
      skill: "Compare official sources",
      use_case: "research",
    });
    // Both routes go through the SDK's typed create methods (agents.run /
    // agents.runs.create) — same shape lands on the wire either way.
    expect(seenUrl).toBe("https://sdk.nimbleway.com/v2/agents/runs");
    expect(seenBody).toMatchObject({
      agent_name: "Research Analyst",
      effort: "medium",
      skill: "Compare official sources",
      use_case: "research",
    });
  });

  it("compiles: CreateRunRequest's typed fields (agent_name, skill, use_case, sources) are accepted on both create routes", () => {
    // Type-only assertion — this test's value is at `tsc --noEmit` time: if
    // nimble-js 1.2.0's AgentCreateParams/AgentRunParams ever drop one of
    // these fields, this file fails to compile before any test runs.
    const shared: CreateRunRequest = {
      input: "task",
      agent_name: "Research Analyst",
      effort: "medium",
      skill: "Compare official sources",
      use_case: "research",
      sources: { allow: [{ title: "Official", domains: ["example.com"] }] },
    };
    const withAgentId: [string, CreateRunRequest] = [AGENT_ID, shared];
    const withoutAgentId: [undefined, CreateRunRequest] = [undefined, shared];
    expect(withAgentId[1]).toBe(shared);
    expect(withoutAgentId[1]).toBe(shared);
  });

  it("agentful create rejects a response whose web_search_agent_id does not match the requested agent_id", async () => {
    const otherAgentId = "wsa_someoneElsesAgent";
    const fetchImpl = fakeFetch(
      () =>
        new Response(
          JSON.stringify({ id: RUN_ID, web_search_agent_id: otherAgentId, status: "queued" }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    const client = new NimbleAgentClient({ apiKey: "k", fetchImpl });
    await expect(client.createRun(AGENT_ID, { input: "task" })).rejects.toMatchObject({
      message: expect.stringContaining(otherAgentId),
    });
  });

  it("classifies a 5xx create as ambiguous (not a definite rejection) with reconciliation guidance, and never retries it", async () => {
    const fetchImpl = fakeFetch(() => new Response("upstream error", { status: 502 }));
    const client = new NimbleAgentClient({ apiKey: "k", fetchImpl });
    const err = await client.createRun(AGENT_ID, { input: "task" }).catch((e) => e);
    expect(err).toBeInstanceOf(AmbiguousCreateError);
    expect(err).toMatchObject({
      statusCode: 502,
      message: expect.stringMatching(/do not resubmit/i),
    });
    expect(err.message).toMatch(/reconcile/i);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    await client.createRun(AGENT_ID, { input: "task" }).catch(() => {});
    expect(fetchImpl).toHaveBeenCalledTimes(2); // one attempt per createRun call, no internal retry
  });

  it("keeps Max selectable but stops with positive engagement guidance before fetch", async () => {
    const fetchImpl = fakeFetch(() => new Response("{}", { status: 200 }));
    const client = new NimbleAgentClient({ apiKey: "k", fetchImpl });
    await expect(client.createRun(AGENT_ID, { input: "task", effort: "max" })).rejects.toMatchObject(
      {
        name: "GatedFeatureError",
        feature: "effort:max",
        closestAvailable: "x-high",
        engagementUrl: "https://www.nimbleway.com/contact",
      },
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects an unknown effort before fetch", async () => {
    const fetchImpl = fakeFetch(() => new Response("{}", { status: 200 }));
    const client = new NimbleAgentClient({ apiKey: "k", fetchImpl });
    await expect(
      client.createRun(AGENT_ID, { input: "task", effort: "turbo" } as never),
    ).rejects.toThrow(/low, medium, high, x-high, max/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("getRunStatus GETs /v2/agents/{agent_id}/runs/{run_id}", async () => {
    let seenUrl = "";
    const fetchImpl = fakeFetch((url) => {
      seenUrl = url;
      return new Response(JSON.stringify({ id: RUN_ID, status: "running" }), { status: 200 });
    });
    const client = new NimbleAgentClient({ apiKey: "k", fetchImpl, sleep: noopSleep() });
    await client.getRunStatus(AGENT_ID, RUN_ID);
    expect(seenUrl).toBe(`https://sdk.nimbleway.com/v2/agents/${AGENT_ID}/runs/${RUN_ID}`);
  });

  it("getRunResult GETs /v2/agents/{agent_id}/runs/{run_id}/result", async () => {
    let seenUrl = "";
    const fetchImpl = fakeFetch((url) => {
      seenUrl = url;
      return new Response(JSON.stringify({ text: "ok" }), { status: 200 });
    });
    const client = new NimbleAgentClient({ apiKey: "k", fetchImpl, sleep: noopSleep() });
    await client.getRunResult(AGENT_ID, RUN_ID);
    expect(seenUrl).toBe(`https://sdk.nimbleway.com/v2/agents/${AGENT_ID}/runs/${RUN_ID}/result`);
  });

  it("rejects malformed agent_id / run_id before making a request", async () => {
    const fetchImpl = fakeFetch(() => new Response("{}", { status: 200 }));
    const client = new NimbleAgentClient({ apiKey: "k", fetchImpl });
    await expect(client.createRun("not-an-id", { input: "x" })).rejects.toThrow(/agent_id/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
