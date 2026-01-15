import { Schema, model, models, Model, Document, Types } from 'mongoose';

export interface ICustomerExternal extends Document {
  customerId: Types.ObjectId;
  channelAccountId: Types.ObjectId;
  channel: string;
  externalId: string;
  raw?: any;
  syncedAt?: Date;
}

const CustomerExternalSchema = new Schema<ICustomerExternal>(
  {
    customerId: { type: Schema.Types.ObjectId, ref: 'Customer', required: true, index: true },
    channelAccountId: { type: Schema.Types.ObjectId, ref: 'ChannelAccount', required: true, index: true },
    channel: { type: String, required: true, index: true },
    externalId: { type: String, required: true },
    raw: { type: Schema.Types.Mixed },
    syncedAt: { type: Date },
  },
  { timestamps: true },
);

CustomerExternalSchema.index({ channelAccountId: 1, externalId: 1 }, { unique: true });

export const CustomerExternal: Model<ICustomerExternal> =
  (models.CustomerExternal as Model<ICustomerExternal>) ||
  model<ICustomerExternal>('CustomerExternal', CustomerExternalSchema);


