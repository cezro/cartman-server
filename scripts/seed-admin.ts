import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in .env.');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DIRECT_URL || process.env.DATABASE_URL }),
});

async function main() {
  const email = 'admin@cartman.ph';
  const password = 'AdminPassword123!';
  const fullName = 'Admin User';
  const phone = '+639170000000';

  console.log(`Checking Supabase Auth for ${email}...`);
  const { data: listData, error: listErr } = await supabase.auth.admin.listUsers({ page: 1, perPage: 1000 });
  if (listErr) {
    throw listErr;
  }

  let authUser = listData.users.find((u) => u.email === email);

  if (!authUser) {
    console.log(`Creating new auth user ${email}...`);
    const { data: createData, error: createErr } = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { full_name: fullName, role: 'admin' },
    });
    if (createErr) throw createErr;
    authUser = createData.user;
    console.log(`Created Auth User ID: ${authUser.id}`);
  } else {
    console.log(`Auth user already exists (ID: ${authUser.id}). Updating password & metadata...`);
    const { error: updateErr } = await supabase.auth.admin.updateUserById(authUser.id, {
      password,
      email_confirm: true,
      user_metadata: { full_name: fullName, role: 'admin' },
    });
    if (updateErr) throw updateErr;
    console.log(`Updated Auth user password & metadata.`);
  }

  console.log(`Upserting profiles table row for ID: ${authUser.id}...`);
  const profile = await prisma.profiles.upsert({
    where: { id: authUser.id },
    create: {
      id: authUser.id,
      full_name: fullName,
      phone,
      role: 'admin',
      suspended: false,
    },
    update: {
      full_name: fullName,
      role: 'admin',
      suspended: false,
    },
  });

  console.log('Successfully configured Admin Profile:');
  console.log({
    id: profile.id,
    full_name: profile.full_name,
    role: profile.role,
    suspended: profile.suspended,
  });
}

main()
  .catch((e) => {
    console.error('Error seeding admin user:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
