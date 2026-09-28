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

// Demo-only personas (s-09 audit G-09-2): seeded only when SEED_DEMO_PERSONAS=true.
// The ADMIN persona always comes from BOOTSTRAP_ADMIN_EMAIL/NAME/PASSWORD below.
const DEMO_PERSONAS: PersonaSeed[] = [
  { email: "finance@example.com", name: "Finance Director", role: "FINANCE" },
  { email: "ops@example.com", name: "Operations Lead", role: "OPERATIONS" },
  { email: "support@example.com", name: "Support Specialist", role: "SUPPORT" },
  { email: "viewer@example.com", name: "Executive Observer", role: "VIEWER" },
];

function isTrueFlag(value: string | undefined): boolean {
  return (value ?? "").toLowerCase().trim() === "true";
}

async function seedBootstrapAdmin() {
  console.log("🌱 Starting Bootstrap Admin & Demo Tenant Seeding...");

  const tenantName = process.env.BOOTSTRAP_TENANT_NAME || "Demo Organization";
  const tenantSlug = (process.env.BOOTSTRAP_TENANT_SLUG || "demo-tenant").toLowerCase().trim();
  // s-09 audit G-09-2: honor bootstrap env for the ADMIN user (backward-compat defaults preserved).
  const adminEmail = (process.env.BOOTSTRAP_ADMIN_EMAIL || "admin@example.com").toLowerCase().trim();
  const adminName = process.env.BOOTSTRAP_ADMIN_NAME || "System Admin";
  const adminPassword = process.env.BOOTSTRAP_ADMIN_PASSWORD || "Admin12345!@#";
  const seedDemos = isTrueFlag(process.env.SEED_DEMO_PERSONAS);
  // Never overwrite existing password hashes on re-runs unless explicitly requested.
  const resetPasswords = isTrueFlag(process.env.BOOTSTRAP_RESET_PASSWORDS);

  const personas: PersonaSeed[] = [
    { email: adminEmail, name: adminName, role: "ADMIN" },
    ...(seedDemos ? DEMO_PERSONAS : []),
  ];
  if (!seedDemos) {
    console.log("ℹ️  SEED_DEMO_PERSONAS!=true — seeding ADMIN only (set SEED_DEMO_PERSONAS=true for the 4 demo personas).");
  }

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

      // 2. Check or create persona users
      for (const persona of personas) {
        const user = await findUserByEmail(
          { tx },
          { tenantId: tenant.id, email: persona.email },
        );

        if (!user) {
          console.log(`👤 Creating ${persona.role} user '${persona.email}'...`);
          const created = await createUser(
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
          console.log(`✅ ${persona.role} user created (ID: ${created.id})`);
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
              // Preserve existing password hashes unless BOOTSTRAP_RESET_PASSWORDS=true.
              ...(resetPasswords ? { passwordHash } : {}),
            },
          );
          console.log(
            `✅ ${persona.role} user updated${resetPasswords ? " (password reset)" : " (password preserved)"}`,
          );
        }
      }
    });

    console.log("✨ Seeding completed successfully!");
  } catch (err: unknown) {
    console.error("❌ Seeding failed:", err instanceof Error ? err.message : err);
    process.exit(1);
  } finally {
    await end();
  }
}

if ((import.meta as { main?: boolean }).main || process.argv[1]?.endsWith("seed-admin.ts")) {
  seedBootstrapAdmin().then(() => process.exit(0));
}
