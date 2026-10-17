/**
 * Creates (or resets) the SUPERADMIN login from environment variables without
 * touching any other data. Safe to run against production.
 *
 *   SUPERADMIN_NAME, SUPERADMIN_EMAIL, SUPERADMIN_PASSWORD  (from .env)
 *   npm run create:superadmin
 */
import { PrismaClient } from '@prisma/client';
import * as argon2 from 'argon2';

const prisma = new PrismaClient();

async function main() {
  const name = process.env.SUPERADMIN_NAME?.trim() || 'Super Admin';
  const email = process.env.SUPERADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.SUPERADMIN_PASSWORD;
  if (!email || !password) throw new Error('Set SUPERADMIN_EMAIL and SUPERADMIN_PASSWORD in the environment');
  if (password.length < 8) throw new Error('SUPERADMIN_PASSWORD must be at least 8 characters');

  const passwordHash = await argon2.hash(password);
  const user = await prisma.user.upsert({
    where: { email },
    create: { name, email, passwordHash, role: 'SUPERADMIN', status: 'ACTIVE' },
    update: { name, passwordHash, role: 'SUPERADMIN', status: 'ACTIVE' },
    select: { id: true, email: true },
  });
  // A password reset must end existing sessions.
  await prisma.refreshSession.updateMany({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: new Date() } });
  console.log(`Superadmin ready: ${user.email}`);
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
