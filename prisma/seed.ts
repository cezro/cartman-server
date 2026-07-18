// ╔══════════════════════════════════════════════════════════════════════════╗
// ║ Cartman Server — Dev seed                                                ║
// ║ Provisions everything an end-to-end order smoke test needs against the   ║
// ║ dev Supabase database. Idempotent — safe to run repeatedly.              ║
// ╚══════════════════════════════════════════════════════════════════════════╝
//
// profiles.id is a FK to auth.users(id) (Supabase's auth schema, not modeled
// in schema.prisma), so we cannot insert a bare `profiles` row. Auth users
// are created via the Supabase Admin API; a DB trigger (handle_new_user(),
// see cartman-mobile/supabase/migrations/20260630000200_functions.sql)
// auto-creates the matching profiles (+ riders, for role=rider) row. We also
// upsert profiles/riders via Prisma so the seed still works if that trigger
// is absent or its defaults drift.
//
// Money is stored as BigInt centavos (₱99.00 = 9900n) — never floats.

import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { createClient, type User } from '@supabase/supabase-js';

const SEED_PASSWORD = 'CartmanDev1!';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error(
    'SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in .env to run the seed.',
  );
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// Seed's own connection: direct (non-pgbouncer), separate from the app's
// runtime PrismaService which pools through DATABASE_URL.
const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DIRECT_URL }),
});

// Auth Admin API has no "find by email" — list (a page of) users and filter.
// Fine for a small dev project; revisit with paging if the user base grows.
async function findAuthUserByEmail(email: string): Promise<User | undefined> {
  const { data, error } = await supabase.auth.admin.listUsers({
    page: 1,
    perPage: 1000,
  });
  if (error) throw error;
  return data.users.find((u) => u.email === email);
}

async function ensureAuthUser(params: {
  email: string;
  fullName: string;
  role: string;
  phone: string;
}): Promise<User> {
  const { email, fullName, role, phone } = params;

  const existing = await findAuthUserByEmail(email);
  if (existing) {
    console.log(`  auth user already exists: ${email} (${existing.id})`);
    return existing;
  }

  const { data, error } = await supabase.auth.admin.createUser({
    email,
    password: SEED_PASSWORD,
    email_confirm: true,
    phone,
    user_metadata: { full_name: fullName, role },
  });
  if (error) throw error;
  console.log(`  created auth user: ${email} (${data.user.id})`);
  return data.user;
}

async function seedCustomer() {
  console.log('Seeding customer...');
  const user = await ensureAuthUser({
    email: 'seed-customer@cartman.ph',
    fullName: 'Seed Customer',
    role: 'customer',
    phone: '+639170000001',
  });

  await prisma.profiles.upsert({
    where: { id: user.id },
    create: {
      id: user.id,
      full_name: 'Seed Customer',
      phone: '+639170000001',
      role: 'customer',
    },
    update: {
      full_name: 'Seed Customer',
      phone: '+639170000001',
      role: 'customer',
    },
  });

  return user;
}

async function seedRider() {
  console.log('Seeding rider...');
  const user = await ensureAuthUser({
    email: 'seed-rider@cartman.ph',
    fullName: 'Seed Rider',
    role: 'rider',
    phone: '+639170000002',
  });

  await prisma.profiles.upsert({
    where: { id: user.id },
    create: {
      id: user.id,
      full_name: 'Seed Rider',
      phone: '+639170000002',
      role: 'rider',
    },
    update: {
      full_name: 'Seed Rider',
      phone: '+639170000002',
      role: 'rider',
    },
  });

  await prisma.riders.upsert({
    where: { id: user.id },
    create: {
      id: user.id,
      vehicle: 'motorcycle',
      plate_no: 'SEED-001',
      is_active: false,
    },
    update: {
      vehicle: 'motorcycle',
      plate_no: 'SEED-001',
      is_active: false,
    },
  });

  return user;
}

async function seedMerchant() {
  console.log('Seeding merchant...');

  // merchants.id is generated and `name` isn't unique — find-by-name first.
  let merchant = await prisma.merchants.findFirst({
    where: { name: 'Kusina ni Aling Nena' },
  });

  if (!merchant) {
    merchant = await prisma.merchants.create({
      data: {
        name: 'Kusina ni Aling Nena',
        category: 'Filipino',
        delivery_fee: 4900n,
        min_order: 10000n,
        eta_minutes: 25,
        is_open: true,
      },
    });
    console.log(`  created merchant: ${merchant.name} (${merchant.id})`);
  } else {
    console.log(`  merchant already exists: ${merchant.name} (${merchant.id})`);
  }

  const menuItems: Array<{ name: string; price: bigint }> = [
    { name: 'Chicken Adobo', price: 12000n },
    { name: 'Pancit Bihon', price: 9500n },
    { name: 'Lumpiang Shanghai (6 pcs)', price: 8000n },
  ];

  for (const item of menuItems) {
    const existing = await prisma.menu_items.findFirst({
      where: { merchant_id: merchant.id, name: item.name },
    });
    if (existing) {
      console.log(`  menu item already exists: ${item.name}`);
      continue;
    }
    await prisma.menu_items.create({
      data: {
        merchant_id: merchant.id,
        name: item.name,
        price: item.price,
        category: 'Mains',
        in_stock: true,
      },
    });
    console.log(`  created menu item: ${item.name}`);
  }

  return merchant;
}

// The Merchant Panel discovers its store(s) through merchant_users (RLS
// returns own links only) and cartman-server's accept/ready/reject guard
// requires the same membership row — a merchant login without one sees
// "No store linked yet" and can act on nothing.
async function seedMerchantUser(merchantId: string) {
  console.log('Seeding merchant panel login...');
  const user = await ensureAuthUser({
    email: 'seed-merchant@cartman.ph',
    fullName: 'Aling Nena',
    role: 'merchant',
    phone: '+639170000003',
  });

  await prisma.profiles.upsert({
    where: { id: user.id },
    create: {
      id: user.id,
      full_name: 'Aling Nena',
      phone: '+639170000003',
      role: 'merchant',
    },
    update: {
      full_name: 'Aling Nena',
      phone: '+639170000003',
      role: 'merchant',
    },
  });

  await prisma.merchant_users.upsert({
    where: {
      merchant_id_user_id: { merchant_id: merchantId, user_id: user.id },
    },
    create: { merchant_id: merchantId, user_id: user.id },
    update: {},
  });
  console.log(`  linked ${user.email} to merchant ${merchantId}`);

  return user;
}

// Belt-and-suspenders safety net: `order_ref_seq` is provisioned by
// cartman-mobile's supabase/migrations (source of truth) and should already
// exist on any DB that ran them. `prisma db push` (used by render.yaml's
// preDeployCommand) only pushes what's in schema.prisma and CANNOT create
// bare sequences, so a fresh prod DB that skipped the migrations would 500
// on every order (the `orders.ref_no` trigger calls `nextval(...)` on a
// sequence that doesn't exist). Idempotent — safe to run against a DB where
// the sequence already exists.
async function ensureOrderRefSeq() {
  await prisma.$executeRawUnsafe(
    'create sequence if not exists public.order_ref_seq;',
  );
}

async function main() {
  await ensureOrderRefSeq();
  await seedCustomer();
  await seedRider();
  const merchant = await seedMerchant();
  await seedMerchantUser(merchant.id);
  console.log('Seed complete.');
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
