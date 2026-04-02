import fs from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

interface McpServerConfig {
  type?: string;
  url: string;
  enabled?: boolean;
}

interface OpencodeConfig {
  mcp?: Record<string, McpServerConfig>;
}

let cachedMcpConfig: Record<string, McpServerConfig> | null = null;

function loadMcpConfig(): Record<string, McpServerConfig> {
  if (cachedMcpConfig) {
    return cachedMcpConfig;
  }

  const configPath = path.resolve(".opencode/opencode.json");
  if (!fs.existsSync(configPath)) {
    throw new Error(`Missing OpenCode config at ${configPath}`);
  }

  const parsed = JSON.parse(fs.readFileSync(configPath, "utf8")) as OpencodeConfig;
  cachedMcpConfig = parsed.mcp ?? {};
  return cachedMcpConfig;
}

function parseContentJson(result: unknown): unknown {
  if (typeof result !== "object" || result === null) {
    return result;
  }

  const maybeResult = result as { structuredContent?: unknown; content?: Array<{ type?: string; text?: string }> };

  if (typeof maybeResult.structuredContent === "object" && maybeResult.structuredContent !== null) {
    const structured = maybeResult.structuredContent as Record<string, unknown>;
    const nestedResult = structured.result;
    if (typeof nestedResult === "string") {
      try {
        return JSON.parse(nestedResult);
      } catch {
        return structured;
      }
    }
    return structured;
  }

  const textPart = maybeResult.content?.find((item) => item.type === "text" && typeof item.text === "string");
  if (!textPart?.text) {
    return result;
  }

  try {
    return JSON.parse(textPart.text);
  } catch {
    return textPart.text;
  }
}

async function withMcpClient<T>(serverName: string, fn: (client: Client) => Promise<T>): Promise<T> {
  const mcp = loadMcpConfig();
  const server = mcp[serverName];

  if (!server) {
    throw new Error(`MCP server not configured: ${serverName}`);
  }
  if (server.enabled === false) {
    throw new Error(`MCP server is disabled: ${serverName}`);
  }

  if (process.env.MCP_INSECURE_TLS === "1" && process.env.NODE_TLS_REJECT_UNAUTHORIZED !== "0") {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  }

  const url = new URL(server.url);
  const client = new Client({ name: "astro-code-orchestrator", version: "0.1.0" });

  let connected = false;
  let lastError: unknown = null;

  const transports = url.pathname.endsWith("/sse")
    ? [new SSEClientTransport(url), new StreamableHTTPClientTransport(url)]
    : [new StreamableHTTPClientTransport(url), new SSEClientTransport(url)];

  for (const transport of transports) {
    try {
      await client.connect(transport);
      connected = true;
      break;
    } catch (error) {
      lastError = error;
    }
  }

  if (!connected) {
    const message = String(lastError);
    if (message.includes("certificate") || message.includes("self signed")) {
      throw new Error(`${message}. If this is a self-signed cert, run with MCP_INSECURE_TLS=1.`);
    }
    throw new Error(`Failed to connect MCP server ${serverName}: ${message}`);
  }

  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

export async function callMcpTool(
  serverName: string,
  toolName: string,
  input: Record<string, unknown>
): Promise<unknown> {
  return withMcpClient(serverName, async (client) => {
    const raw = await client.callTool({ name: toolName, arguments: input });
    return parseContentJson(raw);
  });
}
