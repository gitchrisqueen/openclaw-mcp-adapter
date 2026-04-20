import { parseConfig, type ServerConfig } from "./config.js";
import { McpClientPool } from "./mcp-client.js";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

// Tool manifest cached to disk so agent sessions (fresh plugin loads) see the same tools
// without needing the service start() lifecycle to have run.
const CACHE_FILE = join(dirname(fileURLToPath(import.meta.url)), "tool-cache.json");

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

export default function (api: any) {
  const baseConfig = parseConfig(api.pluginConfig);
  let cache: ToolCache | null = null;
  if (existsSync(CACHE_FILE)) {
    try {
      cache = JSON.parse(readFileSync(CACHE_FILE, "utf8"));
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
  api.registerService({
    id: "mcp-adapter",

    async start() {
      // Brief startup pause so local stdio-based MCP services can warm up
      await new Promise(r => setTimeout(r, 3000));

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
        let connected = false;
        let lastErr: unknown;
        for (let attempt = 1; attempt <= 3; attempt++) {
          try {
            if (attempt > 1) {
              console.log(`[mcp-adapter] Retrying ${server.name} (attempt ${attempt}/3)...`);
              await new Promise(r => setTimeout(r, 5000 * (attempt - 1)));
            }
            console.log(`[mcp-adapter] Connecting to ${server.name}...`);
            await pool.connect(server);
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

      const mergedCacheTools = config.servers.flatMap((server) => refreshedToolsByServer.get(server.name) ?? []);

      // Write updated cache so next fresh-load gets current tool manifest
      if (mergedCacheTools.length > 0) {
        try {
          const cache: ToolCache = {
            timestamp: new Date().toISOString(),
            servers: config.servers,
            toolPrefix: config.toolPrefix,
            tools: mergedCacheTools,
          };
          writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
          console.log(`[mcp-adapter] Cache updated: ${mergedCacheTools.length} tools written to ${CACHE_FILE}`);
        } catch (err) {
          console.error("[mcp-adapter] Failed to write tool cache:", err);
        }
      }
    },

    async stop() {
      console.log("[mcp-adapter] Shutting down...");
      await pool.closeAll();
      console.log("[mcp-adapter] All connections closed");
    },
  });
}
