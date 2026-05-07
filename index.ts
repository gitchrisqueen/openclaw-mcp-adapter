import { parseConfig, type ServerConfig } from "./config.js";
import { McpClientPool } from "./mcp-client.js";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

// Tool manifest cached to disk so agent sessions (fresh plugin loads) see the same tools
// without needing the service start() lifecycle to have run.
const moduleDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = moduleDir.endsWith("/dist") ? dirname(moduleDir) : moduleDir;
const CACHE_FILE = join(packageRoot, "tool-cache.json");
const PLUGIN_MANIFEST_FILE = join(packageRoot, "openclaw.plugin.json");

interface CachedTool {
  serverName: string;
  toolName: string;
  registeredName: string;
  description: string;
  inputSchema: unknown;
}

interface ToolCache {
  timestamp: string;
  servers?: ServerConfig[];
  toolPrefix?: boolean;
  tools: CachedTool[];
}

function syncManifestContracts(toolNames: string[]) {
  if (!existsSync(PLUGIN_MANIFEST_FILE)) return;
  const nextTools = Array.from(new Set(toolNames)).sort();
  try {
    const manifest = JSON.parse(readFileSync(PLUGIN_MANIFEST_FILE, "utf8"));
    const currentTools = Array.isArray(manifest?.contracts?.tools)
      ? [...manifest.contracts.tools].sort()
      : [];
    if (JSON.stringify(currentTools) === JSON.stringify(nextTools)) return;
    manifest.contracts = {
      ...(manifest.contracts ?? {}),
      tools: nextTools,
    };
    writeFileSync(PLUGIN_MANIFEST_FILE, JSON.stringify(manifest, null, 2) + "\n");
    console.log(`[mcp-adapter] Manifest contracts.tools synced (${nextTools.length} tools)`);
  } catch (err) {
    console.error("[mcp-adapter] Failed to sync manifest contracts.tools:", err);
  }
}

export default function (api: any) {
  const baseConfig = parseConfig(api.pluginConfig);
  const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
  let cache: ToolCache | null = null;
  if (existsSync(CACHE_FILE)) {
    try {
      cache = JSON.parse(readFileSync(CACHE_FILE, "utf8"));
      syncManifestContracts((cache?.tools ?? []).map((tool) => tool.registeredName));
    } catch (err) {
      console.error("[mcp-adapter] Failed to parse tool cache:", err);
    }
  }

  const config = {
    servers: baseConfig.servers.length > 0 ? baseConfig.servers : (cache?.servers ?? []),
    toolPrefix: baseConfig.servers.length > 0 ? baseConfig.toolPrefix : (cache?.toolPrefix ?? baseConfig.toolPrefix),
  };

  if (config.servers.length === 0) {
    console.log("[mcp-adapter] No servers configured");
    return;
  }

  // Shared pool — used by both cached registrations (on-demand connect) and start() (proactive connect).
  const pool = new McpClientPool();
  let refreshPromise: Promise<void> | null = null;
  let stopping = false;

  // Build execute handler that connects on demand if the pool has no live entry yet.
  function makeExecutor(serverName: string, toolName: string) {
    return async (_id: string, params: unknown) => {
      if (!pool.getStatus(serverName).connected) {
        const server = config.servers.find(s => s.name === serverName);
        if (!server) throw new Error(`[mcp-adapter] Server config not found: ${serverName}`);
        try {
          await pool.connect(server);
        } catch (err) {
          console.error(`[mcp-adapter] On-demand connect failed for ${serverName}:`, err);
          throw err;
        }
      }
      const result = await pool.callTool(serverName, toolName, params);
      const text = result.content?.map((c: any) => c.text ?? c.data ?? "").join("\n") ?? "";
      return { content: [{ type: "text", text }], isError: result.isError };
    };
  }

  // ── Phase 1: Synchronous cache load ──────────────────────────────────────────
  // This runs on EVERY plugin load (gateway startup AND per-agent fresh loads).
  // Tools registered here use on-demand connections, making them available even
  // when start() has not been called (i.e., in agent session fresh-load contexts).
  if (cache) {
    try {
      let count = 0;
      for (const t of cache.tools) {
        api.registerTool({
          name: t.registeredName,
          description: t.description,
          parameters: t.inputSchema ?? { type: "object", properties: {} },
          execute: makeExecutor(t.serverName, t.toolName),
        });
        count++;
      }
      console.log(`[mcp-adapter] Loaded ${count} tools from cache (cached at ${cache.timestamp})`);
    } catch (err) {
      console.error("[mcp-adapter] Failed to load tool cache:", err);
    }
  } else {
    console.log("[mcp-adapter] No tool cache found — will populate on first gateway start()");
  }

  // ── Phase 2: Service lifecycle (gateway startup only) ────────────────────────
  // Establishes proactive connections, refreshes tool list, and writes updated cache.
  async function refreshToolCache() {
    // Brief startup pause so local stdio-based MCP services can warm up.
    // Run this in the background so cached tools stay available while the
    // gateway finishes binding its HTTP listener.
    await delay(3000);
    if (stopping) return;

    const cachedToolsByServer = new Map<string, CachedTool[]>();
    if (cache) {
      for (const tool of cache.tools) {
        const existing = cachedToolsByServer.get(tool.serverName) ?? [];
        existing.push(tool);
        cachedToolsByServer.set(tool.serverName, existing);
      }
    }
    const refreshedToolsByServer = new Map<string, CachedTool[]>();

    for (const server of config.servers) {
      if (stopping) return;

      let connected = false;
      let lastErr: unknown;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          if (attempt > 1) {
            console.log(`[mcp-adapter] Retrying ${server.name} (attempt ${attempt}/3)...`);
            await delay(5000 * (attempt - 1));
            if (stopping) return;
          }
          console.log(`[mcp-adapter] Connecting to ${server.name}...`);
          await pool.connect(server);
          if (stopping) return;
          connected = true;
          break;
        } catch (err) {
          lastErr = err;
        }
      }
      if (!connected) {
        console.error(`[mcp-adapter] Failed to connect to ${server.name}:`, lastErr);
        const cachedServerTools = cachedToolsByServer.get(server.name);
        if (cachedServerTools && cachedServerTools.length > 0) {
          refreshedToolsByServer.set(server.name, cachedServerTools);
          console.log(`[mcp-adapter] Preserving ${cachedServerTools.length} cached tools for ${server.name}`);
        }
        continue;
      }

      try {
        const tools = await pool.listTools(server.name);
        if (stopping) return;
        console.log(`[mcp-adapter] ${server.name}: found ${tools.length} tools`);
        const newCacheTools: CachedTool[] = [];

        const filteredTools = tools.filter((tool) => {
          const n = tool.name;
          if (server.allowTools && server.allowTools.length > 0) {
            if (!server.allowTools.includes(n)) return false;
          }
          if (server.denyTools && server.denyTools.includes(n)) return false;
          return true;
        });
        if (filteredTools.length !== tools.length) {
          console.log(`[mcp-adapter] ${server.name}: filtered to ${filteredTools.length} tools (allowTools/denyTools applied)`);
        }

        for (const tool of filteredTools) {
          if (stopping) return;
          const registeredName = config.toolPrefix ? `${server.name}_${tool.name}` : tool.name;

          // Re-register with live pool connection (overrides any cached registration).
          api.registerTool({
            name: registeredName,
            description: tool.description ?? `Tool from ${server.name}`,
            parameters: tool.inputSchema ?? { type: "object", properties: {} },
            execute: makeExecutor(server.name, tool.name),
          });

          console.log(`[mcp-adapter] Registered: ${registeredName}`);

          newCacheTools.push({
            serverName: server.name,
            toolName: tool.name,
            registeredName,
            description: tool.description ?? `Tool from ${server.name}`,
            inputSchema: tool.inputSchema ?? { type: "object", properties: {} },
          });
        }
        refreshedToolsByServer.set(server.name, newCacheTools);
      } catch (err) {
        console.error(`[mcp-adapter] Failed to list/register tools for ${server.name}:`, err);
        const cachedServerTools = cachedToolsByServer.get(server.name);
        if (cachedServerTools && cachedServerTools.length > 0) {
          refreshedToolsByServer.set(server.name, cachedServerTools);
          console.log(`[mcp-adapter] Preserving ${cachedServerTools.length} cached tools for ${server.name}`);
        }
      }
    }

    if (stopping) return;

    const mergedCacheTools = config.servers.flatMap((server) => refreshedToolsByServer.get(server.name) ?? []);

    // Write updated cache so next fresh-load gets current tool manifest.
    if (mergedCacheTools.length > 0) {
      try {
        const nextCache: ToolCache = {
          timestamp: new Date().toISOString(),
          servers: config.servers,
          toolPrefix: config.toolPrefix,
          tools: mergedCacheTools,
        };
        writeFileSync(CACHE_FILE, JSON.stringify(nextCache, null, 2));
        syncManifestContracts(mergedCacheTools.map((tool) => tool.registeredName));
        cache = nextCache;
        console.log(`[mcp-adapter] Cache updated: ${mergedCacheTools.length} tools written to ${CACHE_FILE}`);
      } catch (err) {
        console.error("[mcp-adapter] Failed to write tool cache:", err);
      }
    }
  }

  api.registerService({
    id: "mcp-adapter",

    async start() {
      stopping = false;
      if (refreshPromise) {
        console.log("[mcp-adapter] Background refresh already running");
        return;
      }
      refreshPromise = refreshToolCache().catch((err) => {
        console.error("[mcp-adapter] Background refresh failed:", err);
      }).finally(() => {
        refreshPromise = null;
      });
      console.log(`[mcp-adapter] Background refresh scheduled for ${config.servers.length} server(s)`);
    },

    async stop() {
      stopping = true;
      console.log("[mcp-adapter] Shutting down...");
      await pool.closeAll();
      console.log("[mcp-adapter] All connections closed");
    },
  });
}
