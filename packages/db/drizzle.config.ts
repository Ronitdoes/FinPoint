import { defineConfig } from "drizzle-kit";
import "dotenv/config";

const url =
  process.env.DIRECT_URL ||
  process.env.DATABASE_URL ||
  "postgres://postgres:postgres@localhost:5432/revenue_recovery";

export default defineConfig({
  schema: "./src/schema/index.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url,
  },
  verbose: true,
  strict: true,
});
