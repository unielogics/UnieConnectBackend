import { Schema, model, models, Model, Document, Types } from 'mongoose';

export interface IItemExternal extends Document {
  itemId: Types.ObjectId;
  channelAccountId: Types.ObjectId;
  channel: string;
  channelItemId: string;
  channelVariantId?: string;
  sku?: string;
  status?: 'active' | 'inactive';
  raw?: any;
  syncedAt?: Date;
}

const ItemExternalSchema = new Schema<IItemExternal>(
  {
    itemId: { type: Schema.Types.ObjectId, ref: 'Item', required: true, index: true },
    channelAccountId: { type: Schema.Types.ObjectId, ref: 'ChannelAccount', required: true, index: true },
    channel: { type: String, required: true, index: true },
    channelItemId: { type: String, required: true },
    channelVariantId: { type: String },
    sku: { type: String },
    status: { type: String, enum: ['active', 'inactive'], default: 'active' },
    raw: { type: Schema.Types.Mixed },
    syncedAt: { type: Date },
  },
  { timestamps: true },
);

ItemExternalSchema.index(
  { channelAccountId: 1, channelItemId: 1, channelVariantId: 1 },
  { unique: true, sparse: true },
);
ItemExternalSchema.index({ channelAccountId: 1, sku: 1 });

export const ItemExternal: Model<IItemExternal> =
  (models.ItemExternal as Model<IItemExternal>) || model<IItemExternal>('ItemExternal', ItemExternalSchema);








