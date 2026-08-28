import { config as baseConfig } from "./base.js";

/**
 * ESLint configuration specifically for services/worker.
 * Enforces strict determinism inside workflow files (Spec 20 §Requirements 3).
 *
 * @type {import("eslint").Linter.Config[]}
 */
export const config = [
  ...baseConfig,
  {
    files: ["**/workflows/**/*.ts", "**/workflows/**/*.js"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@repo/db",
              message: "Direct DB access is prohibited in workflow code. Use proxyActivities instead.",
            },
            {
              name: "@repo/integrations",
              message: "Direct provider/adapter access is prohibited in workflow code. Use proxyActivities instead.",
            },
            {
              name: "ioredis",
              message: "Redis access is prohibited in workflow code.",
            },
            {
              name: "node:fs",
              message: "Direct filesystem access is prohibited in workflow code.",
            },
            {
              name: "fs",
              message: "Direct filesystem access is prohibited in workflow code.",
            },
            {
              name: "node:net",
              message: "Direct socket access is prohibited in workflow code.",
            },
            {
              name: "net",
              message: "Direct socket access is prohibited in workflow code.",
            },
            {
              name: "node:http",
              message: "Direct HTTP calls are prohibited in workflow code. Use proxyActivities instead.",
            },
            {
              name: "http",
              message: "Direct HTTP calls are prohibited in workflow code. Use proxyActivities instead.",
            },
            {
              name: "node:https",
              message: "Direct HTTPS calls are prohibited in workflow code. Use proxyActivities instead.",
            },
            {
              name: "https",
              message: "Direct HTTPS calls are prohibited in workflow code. Use proxyActivities instead.",
            },
          ],
          patterns: [
            {
              group: ["**/activities/**", "!../activities/**"],
              message: "Workflows must not import activity implementations directly; use proxyActivities.",
            },
          ],
        },
      ],
      "no-restricted-globals": [
        "error",
        {
          name: "fetch",
          message: "fetch() is non-deterministic and prohibited in workflow code. Use proxyActivities instead.",
        },
      ],
    },
  },
];
