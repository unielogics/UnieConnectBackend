import bcrypt from 'bcryptjs';
import { connectMongo } from '../src/config/mongo';
import { User } from '../src/models/user';

async function main() {
  const args = process.argv.slice(2);
  const flags = new Set(args.filter((a) => a.startsWith('--')));
  const positional = args.filter((a) => !a.startsWith('--'));

  const email = positional[0] || process.env.NEW_USER_EMAIL;
  const password = positional[1] || process.env.NEW_USER_PASSWORD;
  const updateExisting = flags.has('--update') || String(process.env.UPDATE_EXISTING_USER || '').toLowerCase() === 'true';
  const roleFlag = args.find((a) => a.startsWith('--role='));
  const role = (roleFlag ? roleFlag.split('=')[1] : undefined) || process.env.NEW_USER_ROLE || 'admin';

  if (!email || !password) {
    // eslint-disable-next-line no-console
    console.error('Usage: ts-node scripts/create-user.ts <email> <password> [--update] [--role=admin]');
    process.exit(1);
  }

  await connectMongo();
  const normalizedEmail = String(email).toLowerCase();
  const existing = await User.findOne({ email: normalizedEmail }).exec();
  if (existing) {
    if (!updateExisting) {
      // eslint-disable-next-line no-console
      console.log('User already exists:', normalizedEmail);
      process.exit(0);
    }

    existing.passwordHash = await bcrypt.hash(String(password), 10);
    existing.role = role;
    await existing.save();
    // eslint-disable-next-line no-console
    console.log('Updated user:', normalizedEmail);
    process.exit(0);
  }

  const passwordHash = await bcrypt.hash(String(password), 10);
  await User.create({ email: normalizedEmail, passwordHash, role });
  // eslint-disable-next-line no-console
  console.log('Created user:', normalizedEmail);
  process.exit(0);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
