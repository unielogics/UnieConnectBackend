import bcrypt from 'bcryptjs';
import { connectMongo } from '../src/config/mongo';
import { User } from '../src/models/user';
import { config } from '../src/config/env';

async function main() {
  await connectMongo();
  const email = config.superAdminEmail;
  const password = process.env.SEED_SUPER_ADMIN_PASSWORD || 'changeme';
  const passwordHash = await bcrypt.hash(password, 10);
  const existing = await User.findOne({ email }).exec();
  if (existing) {
    existing.passwordHash = passwordHash;
    existing.role = 'super_admin';
    await existing.save();
    console.log('Updated super_admin:', email);
    process.exit(0);
  }
  await User.create({ email, passwordHash, role: 'super_admin' });
  console.log('Seeded super_admin:', email);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

