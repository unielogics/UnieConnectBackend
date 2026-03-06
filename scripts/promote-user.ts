import { connectMongo } from '../src/config/mongo';
import { User } from '../src/models/user';
import { isValidRole, type UserRole } from '../src/lib/roles';

async function main() {
  const email = process.argv[2] || process.env.PROMOTE_USER_EMAIL;
  const role = (process.argv[3] || process.env.PROMOTE_USER_ROLE || 'super_admin') as UserRole;

  if (!email) {
    console.error('Usage: npx ts-node scripts/promote-user.ts <email> [role]');
    console.error('Example: npx ts-node scripts/promote-user.ts you@example.com super_admin');
    console.error('Roles: super_admin, management, ecommerce_client, billing');
    process.exit(1);
  }

  if (!isValidRole(role)) {
    console.error('Invalid role:', role);
    process.exit(1);
  }

  await connectMongo();
  const normalizedEmail = String(email).toLowerCase();
  const user = await User.findOne({ email: normalizedEmail }).exec();
  if (!user) {
    console.error('User not found:', normalizedEmail);
    process.exit(1);
  }

  user.role = role;
  await user.save();
  console.log('Updated', normalizedEmail, 'to role:', role);
  console.log('User must log out and log back in for the new role to take effect.');
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
