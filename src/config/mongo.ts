import mongoose from 'mongoose';
import { config } from './env';

export async function connectMongo() {
  if (!config.dbUrl) throw new Error('DB_URL not set');
  if (mongoose.connection.readyState === 1) return;
  await mongoose.connect(config.dbUrl);
}

