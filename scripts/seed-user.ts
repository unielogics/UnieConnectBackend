import { connectMongo } from '../src/config/mongo';
import { User } from '../src/models/user';

async function main() {
  await connectMongo();
  const email = 'franco@unielogics.com';
  const passwordHash = '$2b$10$W8d7aVpJv.VpQfifPNdvG.iXa2z8tj8/BFvBr7UWg.VB.STsBoNBy';
  const existing = await User.findOne({ email });
  if (existing) {
    console.log('User already exists:', email);
    process.exit(0);
  }
  await User.create({ email, passwordHash, role: 'admin' });
  console.log('Seeded user:', email);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

