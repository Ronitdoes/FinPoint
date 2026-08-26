import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    passWithNoTests: true,
    projects: [
      {
        test: {
          name: "unit",
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
