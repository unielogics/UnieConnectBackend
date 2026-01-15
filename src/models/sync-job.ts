import { Schema, model, models, Model, Document, Types } from 'mongoose';

export type SyncJobType =
  | 'order_in'
  | 'inventory_out'
  | 'fulfillment_out'
  | 'orders_refresh'
  | 'catalog_refresh'
  | 'inventory_refresh';
export type SyncJobStatus = 'pending' | 'in_progress' | 'failed' | 'completed';

export interface ISyncJob extends Document {
  jobType: SyncJobType;
  channelAccountId: Types.ObjectId;
  payload: any;
  status: SyncJobStatus;
  attempts: number;
  error?: string;
}

const SyncJobSchema = new Schema<ISyncJob>(
  {
    jobType: { type: String, required: true },
    channelAccountId: { type: Schema.Types.ObjectId, ref: 'ChannelAccount', required: true, index: true },
    payload: { type: Schema.Types.Mixed },
    status: { type: String, enum: ['pending', 'in_progress', 'failed', 'completed'], default: 'pending' },
    attempts: { type: Number, default: 0 },
    error: { type: String },
  },
  { timestamps: true },
);

SyncJobSchema.index({ status: 1, jobType: 1, createdAt: 1 });

export const SyncJob: Model<ISyncJob> = (models.SyncJob as Model<ISyncJob>) || model<ISyncJob>('SyncJob', SyncJobSchema);

