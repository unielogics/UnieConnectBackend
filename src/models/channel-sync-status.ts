import { Schema, model, models, Model, Document, Types } from 'mongoose';

export type SyncEntityType = 'products' | 'orders' | 'inventory' | 'customers';
export type SyncEntityStatus = 'idle' | 'syncing' | 'synced' | 'error';

export interface IChannelSyncStatus extends Document {
  channelAccountId: Types.ObjectId;
  entityType: SyncEntityType;
  status: SyncEntityStatus;
  lastSyncedAt?: Date;
  count?: number;
  error?: string;
}

const ChannelSyncStatusSchema = new Schema<IChannelSyncStatus>(
  {
    channelAccountId: { type: Schema.Types.ObjectId, ref: 'ChannelAccount', required: true, index: true },
    entityType: { type: String, required: true, enum: ['products', 'orders', 'inventory', 'customers'], index: true },
    status: { type: String, enum: ['idle', 'syncing', 'synced', 'error'], default: 'idle' },
    lastSyncedAt: { type: Date },
    count: { type: Number },
    error: { type: String },
  },
  { timestamps: true },
);

ChannelSyncStatusSchema.index({ channelAccountId: 1, entityType: 1 }, { unique: true });

export const ChannelSyncStatus: Model<IChannelSyncStatus> =
  (models.ChannelSyncStatus as Model<IChannelSyncStatus>) ||
  model<IChannelSyncStatus>('ChannelSyncStatus', ChannelSyncStatusSchema);
