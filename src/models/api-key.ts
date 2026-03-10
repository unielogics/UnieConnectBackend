import { Schema, model, models, Model, Document, Types } from 'mongoose';

export type ApiKeyType = 'wms' | 'oms';

export interface IApiKey extends Document {
  keyHash: string; // hashed key for lookup (never store raw key)
  type: ApiKeyType;
  /** For OMS keys: the OMS intermediary this key belongs to */
  omsIntermediaryId?: Types.ObjectId;
  /** For WMS keys: the warehouse (Facility) this key is scoped to */
  warehouseId?: Types.ObjectId;
  /** For WMS keys: the intermediary (User) this key is scoped to */
  intermediaryId?: Types.ObjectId;
  name?: string;
  lastUsedAt?: Date;
}

const ApiKeySchema = new Schema<IApiKey>(
  {
    keyHash: { type: String, required: true, unique: true },
    type: { type: String, enum: ['wms', 'oms'], required: true, index: true },
    omsIntermediaryId: { type: Schema.Types.ObjectId, ref: 'OmsIntermediary', index: true },
    warehouseId: { type: Schema.Types.ObjectId, ref: 'Facility', index: true },
    intermediaryId: { type: Schema.Types.ObjectId, ref: 'User', index: true },
    name: { type: String, trim: true },
    lastUsedAt: { type: Date },
  },
  { timestamps: true },
);

ApiKeySchema.index({ type: 1, omsIntermediaryId: 1 });

export const ApiKey: Model<IApiKey> =
  (models.ApiKey as Model<IApiKey>) || model<IApiKey>('ApiKey', ApiKeySchema);
