import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import {
  db,
  end,
  withTransaction,
  findTenantBySlug,
  createTenant,
  findUserByEmail,
  createUser,
  updateUser,
} from "@repo/db";
import { hashPassword } from "../src/lib/crypto";
import type { UserRole } from "@repo/domain";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config();
dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

interface PersonaSeed {
  email: string;
  name: string;
  role: UserRole;
}

const PERSONAS: PersonaSeed[] = [
  { email: "admin@example.com", name: "System Admin", role: "ADMIN" },
  { email: "finance@example.com", name: "Finance Director", role: "FINANCE" },
  { email: "ops@example.com", name: "Operations Lead", role: "OPERATIONS" },
  { email: "support@example.com", name: "Support Specialist", role: "SUPPORT" },
  { email: "viewer@example.com", name: "Executive Observer", role: "VIEWER" },
];

async function seedBootstrapAdmin() {
  console.log("🌱 Starting Bootstrap Admin & Demo Tenant Seeding...");

  const tenantName = process.env.BOOTSTRAP_TENANT_NAME || "Demo Organization";
  const tenantSlug = (process.env.BOOTSTRAP_TENANT_SLUG || "demo-tenant").toLowerCase().trim();
  const defaultPassword = process.env.BOOTSTRAP_ADMIN_PASSWORD || "Admin12345!@#";

  try {
    const passwordHash = await hashPassword(defaultPassword);

    await withTransaction({ db }, async (tx) => {
      // 1. Check or create demo tenant
      let tenant = await findTenantBySlug({ tx }, { slug: tenantSlug });

      if (!tenant) {
        console.log(`🏢 Creating Demo Tenant: '${tenantName}' (${tenantSlug})...`);
        tenant = await createTenant(
          { tx },
          {
            name: tenantName,
            slug: tenantSlug,
            status: "ACTIVE",
          },
        );
      } else {
        console.log(`🏢 Demo Tenant already exists (ID: ${tenant.id})`);
      }

      // 2. Check or create persona users
      for (const persona of PERSONAS) {
        let user = await findUserByEmail(
          { tx },
          { tenantId: tenant.id, email: persona.email },
        );

        if (!user) {
          console.log(`👤 Creating ${persona.role} user '${persona.email}'...`);
          user = await createUser(
            { tx },
            {
              tenantId: tenant.id,
              email: persona.email,
              name: persona.name,
              role: persona.role,
              status: "ACTIVE",
              passwordHash,
            },
          );
          console.log(`✅ ${persona.role} user created (ID: ${user.id})`);
        } else {
          console.log(`👤 Updating ${persona.role} user '${persona.email}'...`);
          await updateUser(
            { tx },
            {
              tenantId: tenant.id,
              userId: user.id,
              name: persona.name,
              role: persona.role,
              status: "ACTIVE",
              passwordHash,
            },
          );
          console.log(`✅ ${persona.role} user updated`);
        }
      }
    });

    console.log("✨ Seeding completed successfully! Default password for all personas is: Admin12345!@#");
  } catch (err: any) {
    console.error("❌ Seeding failed:", err.message);
    process.exit(1);
  } finally {
    await end();
  }
}

if ((import.meta as { main?: boolean }).main || process.argv[1]?.endsWith("seed-admin.ts")) {
  seedBootstrapAdmin().then(() => process.exit(0));
}
