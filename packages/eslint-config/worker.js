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
      "no-restricted-syntax": [
        "error",
        {
          selector: "CallExpression[callee.object.name='Date'][callee.property.name='now']",
          message:
            "Date.now() wall-clock is non-deterministic and prohibited in workflow code. Use Temporal workflow time (sleep/condition) or pass timestamps via activities.",
        },
        {
          selector: "CallExpression[callee.object.name='Math'][callee.property.name='random']",
          message:
            "Math.random() is non-deterministic and prohibited in workflow code. Generate randomness inside activities.",
        },
        {
          selector: "NewExpression[callee.name='Date']",
          message:
            "new Date() wall-clock is prohibited in workflow code. Use Temporal workflow time APIs or activity-provided timestamps.",
        },
        {
          selector: "CallExpression[callee.object.name='Date'][callee.property.name='parse']",
          message:
            "Date.parse() wall-clock parsing is prohibited in workflow code. Parse dates inside activities.",
        },
      ],
    },
  },
  {
    // Workflow co-located tests need DB fakes, wall-clock, and randomness to
    // drive the time-skipping harness — exclude them from determinism bans.
    files: ["**/workflows/**/*.test.ts", "**/workflows/**/*.spec.ts"],
    rules: {
      "no-restricted-imports": "off",
      "no-restricted-globals": "off",
      "no-restricted-syntax": "off",
    },
  },
];
