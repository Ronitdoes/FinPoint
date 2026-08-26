import { config as loadEnv } from "dotenv";
import path from "path";
import { apiConfig } from "@repo/config";

// Dev convenience: load the repo-root .env (silent no-op when absent, e.g. in
// deployments where real env vars are injected by the platform).
loadEnv({ path: path.resolve(import.meta.dirname, "../../../.env") });

const config = apiConfig();

const server = Bun.serve({
  port: config.app.port,
  fetch(req) {
    const url = new URL(req.url);

    // Handle CORS preflight
    if (req.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, PATCH, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
        },
      });
    }

    const headers = {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    };

    // Health check endpoint
    if (url.pathname === "/health" || url.pathname === "/api/health") {
      return Response.json(
        { status: "ok", uptime: process.uptime(), timestamp: new Date().toISOString() },
        { headers }
      );
    }

    // Root API endpoint
    if (url.pathname === "/" || url.pathname === "/api") {
      return Response.json(
        {
          name: "AI-Revenue-Recovery Backend",
          version: "0.1.0",
          status: "running",
          endpoints: {
            health: "/api/health",
          },
        },
        { headers }
      );
    }

    // 404 handler
    return Response.json(
      { error: "Not Found", path: url.pathname },
      { status: 404, headers }
    );
  },
});

console.log(`🚀 Backend server running at http://localhost:${server.port}`);
