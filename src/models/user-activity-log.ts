import { Schema, model, models, Model, Document, Types } from 'mongoose';

export interface IUserActivityLog extends Document {
  userId: Types.ObjectId;
  action: string;
  metadata?: Record<string, unknown>;
  createdAt?: Date;
}

const UserActivityLogSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    action: { type: String, required: true },
    metadata: { type: Schema.Types.Mixed },
  },
  { timestamps: true }
);

UserActivityLogSchema.index({ userId: 1, createdAt: -1 });

export const UserActivityLog: Model<IUserActivityLog> =
  (models.UserActivityLog as Model<IUserActivityLog>) ||
  model<IUserActivityLog>('UserActivityLog', UserActivityLogSchema);
