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
    ],
  },
});
