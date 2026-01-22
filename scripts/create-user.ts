import bcrypt from 'bcryptjs';
import { connectMongo } from '../src/config/mongo';
import { User } from '../src/models/user';

async function main() {
  const email = process.argv[2] || process.env.NEW_USER_EMAIL;
  const password = process.argv[3] || process.env.NEW_USER_PASSWORD;

  if (!email || !password) {
    // eslint-disable-next-line no-console
    console.error('Usage: ts-node scripts/create-user.ts <email> <password>');
    process.exit(1);
  }

  await connectMongo();
  const normalizedEmail = String(email).toLowerCase();
  const existing = await User.findOne({ email: normalizedEmail }).exec();
  if (existing) {
    // eslint-disable-next-line no-console
    console.log('User already exists:', normalizedEmail);
    process.exit(0);
  }

  const passwordHash = await bcrypt.hash(String(password), 10);
  await User.create({ email: normalizedEmail, passwordHash, role: 'admin' });
  // eslint-disable-next-line no-console
  console.log('Created user:', normalizedEmail);
  process.exit(0);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
