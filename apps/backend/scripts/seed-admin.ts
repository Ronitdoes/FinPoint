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
  eq,
  and,
} from "@repo/db";
import { hashPassword } from "../src/lib/crypto";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config();
dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

async function seedBootstrapAdmin() {
  console.log("🌱 Starting Bootstrap Admin & Demo Tenant Seeding...");

  const tenantName = process.env.BOOTSTRAP_TENANT_NAME || "Demo Organization";
  const tenantSlug = (process.env.BOOTSTRAP_TENANT_SLUG || "demo-tenant").toLowerCase().trim();
  const adminEmail = (process.env.BOOTSTRAP_ADMIN_EMAIL || "admin@example.com").toLowerCase().trim();
  const adminPassword = process.env.BOOTSTRAP_ADMIN_PASSWORD || "Admin12345!@#";
  const adminName = process.env.BOOTSTRAP_ADMIN_NAME || "System Admin";

  try {
    const passwordHash = await hashPassword(adminPassword);

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

      // 2. Check or create Admin user
      let adminUser = await findUserByEmail(
        { tx },
        { tenantId: tenant.id, email: adminEmail },
      );

      if (!adminUser) {
        console.log(`👤 Creating Bootstrap ADMIN user '${adminEmail}'...`);
        adminUser = await createUser(
          { tx },
          {
            tenantId: tenant.id,
            email: adminEmail,
            name: adminName,
            role: "ADMIN",
            status: "ACTIVE",
            passwordHash,
          },
        );
        console.log(`✅ Admin user created successfully (ID: ${adminUser.id}, Role: ${adminUser.role})`);
      } else {
        console.log(`👤 Admin user '${adminEmail}' already exists in tenant. Updating credentials & role...`);
        adminUser = (await updateUser(
          { tx },
          {
            tenantId: tenant.id,
            userId: adminUser.id,
            name: adminName,
            role: "ADMIN",
            status: "ACTIVE",
            passwordHash,
          },
        ))!;
        console.log(`✅ Admin user credentials updated (ID: ${adminUser.id})`);
      }
    });

    console.log("✨ Seeding completed successfully!");
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
