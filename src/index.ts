import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerPaypalTools } from "./paypal/tools.js";
import { registerAggregateTools } from "./banks/aggregate-tools.js";
import { registerSofiTools } from "./banks/sofi.js";
import { registerBofaTools } from "./banks/bofa.js";
import { registerCapitalOneTools } from "./banks/capitalone.js";

const server = new McpServer({ name: "finance", version: "1.0.0" });

// Register all tools
registerAggregateTools(server);
registerPaypalTools(server);
registerSofiTools(server);
registerBofaTools(server);
registerCapitalOneTools(server);

// ─── Start Server ───────────────────────────────────────────────────────────────

if (process.env.MCP_TRANSPORT === "http") {
  const { default: express } = await import("express");
  const { StreamableHTTPServerTransport } = await import(
    "@modelcontextprotocol/sdk/server/streamableHttp.js"
  );
  const crypto = await import("crypto");

  const app = express();
  app.use(express.json());

  const transports = new Map<string, InstanceType<typeof StreamableHTTPServerTransport>>();

  app.all("/mcp", async (req, res) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    if (req.method === "GET") {
      const transport = transports.get(sessionId!);
      if (!transport) { res.status(404).send("Session not found"); return; }
      await transport.handleRequest(req, res);
    } else if (req.method === "POST") {
      if (!sessionId) {
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => crypto.randomUUID(),
          onsessioninitialized: (id) => { transports.set(id, transport); },
        });
        transport.onclose = () => {
          if (transport.sessionId) transports.delete(transport.sessionId);
        };
        await server.connect(transport);
        await transport.handleRequest(req, res);
      } else {
        const transport = transports.get(sessionId);
        if (!transport) { res.status(404).send("Session not found"); return; }
        await transport.handleRequest(req, res);
      }
    } else if (req.method === "DELETE") {
      const transport = transports.get(sessionId!);
      if (transport) { await transport.close(); transports.delete(sessionId!); }
      res.status(200).send();
    } else {
      res.status(405).send("Method not allowed");
    }
  });

  const PORT = parseInt(process.env.MCP_PORT || "3100");
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Finance MCP listening on http://0.0.0.0:${PORT}/mcp`);
  });
} else {
  const { StdioServerTransport } = await import(
    "@modelcontextprotocol/sdk/server/stdio.js"
  );
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
