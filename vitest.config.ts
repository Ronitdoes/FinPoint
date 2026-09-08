import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    passWithNoTests: true,
    testTimeout: 30000,
    hookTimeout: 30000,
    projects: [
      {
        test: {
          name: "unit",
          testTimeout: 30000,
          hookTimeout: 30000,
          include: [
            "packages/*/src/**/*.test.ts",
            "apps/*/src/**/*.test.ts",
            "services/*/src/**/*.test.ts",
          ],
        },
      },
      {
        test: {
          name: "security",
          testTimeout: 60000,
          hookTimeout: 60000,
          include: ["tests/security/**/*.test.ts"],
        },
      },
      {
        test: {
          name: "chaos",
          testTimeout: 90000,
          hookTimeout: 90000,
          include: ["tests/chaos/**/*.test.ts"],
        },
      },
    ],
  },
});
