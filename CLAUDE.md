# CLAUDE.md

Guidance for Claude Code (and other coding agents) working in this repo.

## Purpose

An OpenClaw gateway plugin that connects to configured MCP (Model Context Protocol) servers,
discovers their tools, and registers each one as a native OpenClaw agent tool. Calls are proxied
to the MCP server, with reconnect on a dead connection. This is a fork of
`androidStern-personal/openclaw-mcp-adapter`; keep changes upstreamable where practical.

## Stack

- TypeScript ES modules loaded directly by OpenClaw (`package.json` `openclaw.extensions` points
  at `./index.ts`). No build step, no `tsconfig.json`.
- Node >= 18. Single runtime dependency: `@modelcontextprotocol/sdk` (stdio and Streamable HTTP
  client transports).
- Files:
  - `index.ts`: plugin entry. Phase 1 registers tools synchronously from `tool-cache.json` on
    every plugin load; phase 2 (`registerService().start()`, gateway startup only) connects,
    lists tools, applies `allowTools`/`denyTools`, re-registers, and rewrites the cache.
  - `mcp-client.ts`: `McpClientPool` (connect, call, reconnect on transport or SSE disconnect).
  - `config.ts`: `parseConfig` and `${VAR}` interpolation for `env` and `headers`.
  - `openclaw.plugin.json`: plugin id and config JSON Schema.

## Running and testing

There is no automated test suite or CI in this repo. To exercise a change:

```bash
npm install
openclaw plugins install ./            # from the repo root
openclaw gateway restart
openclaw plugins list                  # expect: MCP Adapter | mcp-adapter | loaded
```

Then invoke one of the registered tools from an agent and check the gateway log for
`[mcp-adapter]` lines. A quick syntax check without OpenClaw: `npx tsc --noEmit --module nodenext
--target es2022 --moduleResolution nodenext *.ts` (expect `any`-typed API warnings only).

## Conventions

- Keep the zero-build layout: plain `.ts` files, imports written with `.js` extensions.
- Log with the `[mcp-adapter]` prefix; never let one failing server stop the others from loading.
- Config changes go in three places together: `config.ts` (`ServerConfig`, `parseConfig`),
  `openclaw.plugin.json` (`configSchema`), and the README tables.
- Never commit secrets. Use `${VAR}` references resolved from the gateway environment.
