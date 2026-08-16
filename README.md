# Nimble Cloudflare Agents

First-party Cloudflare Agents integration for Nimble Agent API V2. It provides
a Durable Object-backed agent with resumable create, status, and result tools,
plus a typed adapter for `@nimble-way/nimble-js`.

## Install

```sh
npm install @nimble-way/cloudflare-agents agents
```

## Worker configuration

Export `NimbleRunAgent` from your Worker entry point and bind it as a SQLite
Durable Object:

```ts
export { NimbleRunAgent } from "@nimble-way/cloudflare-agents";
```

```jsonc
{
  "durable_objects": {
    "bindings": [
      { "name": "NIMBLE_RUN_AGENT", "class_name": "NimbleRunAgent" }
    ]
  },
  "migrations": [
    { "tag": "v1", "new_sqlite_classes": ["NimbleRunAgent"] }
  ]
}
```

Set `NIMBLE_API_KEY` as a Worker secret. The agent also accepts an ephemeral
per-request key override; that value is never persisted in its recovery
snapshot or run ledger.

If a Worker serves multiple authenticated principals, route each trusted
principal to a separately named `NimbleRunAgent` instance. Do not multiplex
untrusted users into one instance: its deterministic create deduplication and
durable ledger are intentionally scoped to the Durable Object instance. HTTP
authentication and trusted-principal derivation remain the consuming Worker's
responsibility.

## Lifecycle guarantees

- Create calls use `maxRetries: 0` to avoid duplicate billable work.
- A deterministic key deduplicates equivalent create requests.
- Durable run IDs are recorded before polling begins.
- Safe status/result reads use bounded retries.
- Recovery resumes persisted runs and fails closed when an ephemeral key is no
  longer available.
- Production polling defaults to 10 seconds and rejects shorter intervals.
- `startRun()` accepts work asynchronously, so its first response can have a
  `null` run ID; read lifecycle status to obtain the durable agent/run IDs.
- Background polling has a five-minute local budget. If the provider run is
  still active, later status/result reads reconcile it with safe GETs rather
  than treating the local timeout as a provider failure.

The package owns resumability and Agent API V2 lifecycle behavior. HTTP auth,
UI/playgrounds, hosted deployments, and AI Gateway transport remain concerns
of the consuming Worker and are intentionally outside this repository.

## Development

```sh
npm ci
npm run check
```

## License

Apache-2.0
