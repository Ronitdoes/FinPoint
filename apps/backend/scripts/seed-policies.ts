import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { db, end } from "@repo/db";
import * as repos from "@repo/db";
import { PolicyService } from "../src/modules/policy/policy.service";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config();
dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

async function main() {
  console.log("🛡️ Starting Default Policy Rules Seeding...");
  const service = new PolicyService(db, repos);
  const result = await service.seedDefaultPolicies();
  console.log(`✅ Default policies seeded: ${result.created} created, ${result.existing} already existed.`);
  await end();
  process.exit(0);
}

main().catch(async (err) => {
  console.error("❌ Policy seeding failed:", err);
  await end();
  process.exit(1);
});
