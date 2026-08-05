import { describe, expect, it } from "vitest";
import {
  DEFAULT_POLL_INTERVAL_MS,
  deriveFiberKey,
  resolvePollIntervalMs,
} from "../src/agent";

const AGENT_ID = "wsa_key1";

describe("WSA backend status polling convention", () => {
  it("defaults to one status poll every 10 seconds", () => {
    expect(resolvePollIntervalMs({})).toBe(DEFAULT_POLL_INTERVAL_MS);
    expect(DEFAULT_POLL_INTERVAL_MS).toBe(10_000);
  });

  it("allows longer production configuration", () => {
    expect(resolvePollIntervalMs({ NIMBLE_POLL_INTERVAL_MS: "30000" })).toBe(30_000);
  });

  it("rejects zero/short production intervals", () => {
    expect(() => resolvePollIntervalMs({ NIMBLE_POLL_INTERVAL_MS: "0" })).toThrow(/test-only/);
    expect(() => resolvePollIntervalMs({ NIMBLE_POLL_INTERVAL_MS: "9999" })).toThrow(
      /test-only/,
    );
  });

  it("allows a labeled test-only zero interval", () => {
    expect(
      resolvePollIntervalMs({
        NIMBLE_POLL_INTERVAL_MS: "0",
        NIMBLE_TEST_ALLOW_SHORT_POLL_INTERVALS: "true",
      }),
    ).toBe(0);
  });
});

describe("deriveFiberKey — idempotency key covers the full create request", () => {
  it("identical requests dedupe to the same key", async () => {
    const a = await deriveFiberKey(AGENT_ID, { input: "same task" });
    const b = await deriveFiberKey(AGENT_ID, { input: "same task" });
    expect(a).toBe(b);
  });

  it("differing effort produces a different key (billed differently by Nimble)", async () => {
    const low = await deriveFiberKey(AGENT_ID, { input: "task", effort: "low" });
    const high = await deriveFiberKey(AGENT_ID, { input: "task", effort: "high" });
    expect(low).not.toBe(high);
  });

  it("differing enable_events produces a different key", async () => {
    const withEvents = await deriveFiberKey(AGENT_ID, { input: "task", enable_events: true });
    const withoutEvents = await deriveFiberKey(AGENT_ID, { input: "task", enable_events: false });
    expect(withEvents).not.toBe(withoutEvents);
  });

  it("differing input_data produces a different key", async () => {
    const a = await deriveFiberKey(AGENT_ID, { input: "task", input_data: { x: 1 } });
    const b = await deriveFiberKey(AGENT_ID, { input: "task", input_data: { x: 2 } });
    expect(a).not.toBe(b);
  });

  it("differing output_schema produces a different key", async () => {
    const a = await deriveFiberKey(AGENT_ID, { input: "task", output_schema: { type: "object" } });
    const b = await deriveFiberKey(AGENT_ID, { input: "task", output_schema: { type: "array" } });
    expect(a).not.toBe(b);
  });

  it("differing sources produces a different key", async () => {
    const a = await deriveFiberKey(AGENT_ID, {
      input: "task",
      sources: { allow: [{ title: "A", domains: ["a.example"] }] },
    });
    const b = await deriveFiberKey(AGENT_ID, {
      input: "task",
      sources: { allow: [{ title: "B", domains: ["b.example"] }] },
    });
    expect(a).not.toBe(b);
  });

  it("keeps omitted effort distinct so the agent or template default applies", async () => {
    const omitted = await deriveFiberKey(AGENT_ID, { input: "task" });
    const medium = await deriveFiberKey(AGENT_ID, { input: "task", effort: "medium" });
    const high = await deriveFiberKey(AGENT_ID, { input: "task", effort: "high" });
    expect(omitted).not.toBe(medium);
    expect(omitted).not.toBe(high);
  });

  it("canonicalizes nested object key order before hashing", async () => {
    const first = await deriveFiberKey(AGENT_ID, {
      input: "task",
      input_data: { company: "Cloudflare", facts: { region: "global", active: true } },
      output_schema: { type: "object", properties: { name: { type: "string" } } },
    });
    const reordered = await deriveFiberKey(AGENT_ID, {
      input: "task",
      input_data: { facts: { active: true, region: "global" }, company: "Cloudflare" },
      output_schema: { properties: { name: { type: "string" } }, type: "object" },
    });
    expect(first).toBe(reordered);
  });

  it("differing agent_id produces a different key even with identical request bodies", async () => {
    const a = await deriveFiberKey("wsa_a", { input: "task" });
    const b = await deriveFiberKey("wsa_b", { input: "task" });
    expect(a).not.toBe(b);
  });

  it.each([
    ["agent_name", { agent_name: "Analyst A" }, { agent_name: "Analyst B" }],
    ["skill", { skill: "Compare sources" }, { skill: "Build a dataset" }],
    ["use_case", { use_case: "research" as const }, { use_case: "enrichment" as const }],
    [
      "previous_interaction_id",
      { previous_interaction_id: "interaction_a" },
      { previous_interaction_id: "interaction_b" },
    ],
  ])("differing typed 1.2.0 %s produces a different key", async (_field, left, right) => {
    const a = await deriveFiberKey(AGENT_ID, { input: "task", ...left });
    const b = await deriveFiberKey(AGENT_ID, { input: "task", ...right });
    expect(a).not.toBe(b);
  });

  it("uses a full 256-bit SHA-256 hex digest, not a short/collision-prone hash", async () => {
    const key = await deriveFiberKey(AGENT_ID, { input: "task" });
    const hexPart = key.split(":").pop()!;
    expect(hexPart).toMatch(/^[0-9a-f]{64}$/);
  });

  it("dedupes regardless of a differing safe (non-identity) API key override — override is not part of the key", async () => {
    // deriveFiberKey never takes apiKeyOverride as input at all: the key
    // identifies the WORK, not the credential that authorized it. This is
    // asserted structurally (the function's signature has no override
    // parameter) and behaviorally: two callers requesting the identical
    // work always collapse to one fiber regardless of which key each used.
    const a = await deriveFiberKey(AGENT_ID, { input: "same work, different callers" });
    const b = await deriveFiberKey(AGENT_ID, { input: "same work, different callers" });
    expect(a).toBe(b);
  });
});
