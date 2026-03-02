import { Schema, model, models, Model, Document, Types } from 'mongoose';

export interface IUserFeature extends Document {
  userId: Types.ObjectId;
  featureId: Types.ObjectId;
  enabledAt: Date;
  purchasedAt?: Date;
  status: 'active' | 'trial' | 'expired' | 'disabled';
  subscriptionId?: string; // For paid subscription features
  expiresAt?: Date; // For trials or subscriptions
}

const UserFeatureSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    featureId: { type: Schema.Types.ObjectId, ref: 'Feature', required: true, index: true },
    enabledAt: { type: Date, default: Date.now },
    purchasedAt: { type: Date },
    status: {
      type: String,
      enum: ['active', 'trial', 'expired', 'disabled'],
      default: 'active',
      index: true,
    },
    subscriptionId: { type: String },
    expiresAt: { type: Date, index: true },
  },
  { timestamps: true }
);

// Compound index for quick lookups
UserFeatureSchema.index({ userId: 1, featureId: 1 }, { unique: true });
UserFeatureSchema.index({ userId: 1, status: 1 });

export const UserFeature: Model<IUserFeature> =
  (models.UserFeature as Model<IUserFeature>) || model<IUserFeature>('UserFeature', UserFeatureSchema);
