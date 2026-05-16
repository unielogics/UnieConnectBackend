import mongoose from 'mongoose';
import { config } from './env';
import { isMongoDisabled } from '../services/degraded-auth';

export async function connectMongo() {
  if (isMongoDisabled()) return;
  if (!config.dbUrl) throw new Error('DB_URL not set');
  if (mongoose.connection.readyState === 1) return;
  await mongoose.connect(config.dbUrl, {
    serverSelectionTimeoutMS: process.env.OMS_ALLOW_DEGRADED_START === 'true' ? 5000 : 30000,
  });
}

