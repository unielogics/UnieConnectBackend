import { Schema, model, models, Model, Document, Types } from 'mongoose';

export interface IInventoryLevel extends Document {
  itemId: Types.ObjectId;
  channelAccountId?: Types.ObjectId;
  locationId?: string;
  available: number;
}

const InventoryLevelSchema = new Schema<IInventoryLevel>(
  {
    itemId: { type: Schema.Types.ObjectId, ref: 'Item', required: true, index: true },
    channelAccountId: { type: Schema.Types.ObjectId, ref: 'ChannelAccount', index: true },
    locationId: { type: String },
    available: { type: Number, required: true, default: 0 },
  },
  { timestamps: true },
);

InventoryLevelSchema.index({ itemId: 1, channelAccountId: 1, locationId: 1 }, { unique: true, sparse: true });

export const InventoryLevel: Model<IInventoryLevel> =
  (models.InventoryLevel as Model<IInventoryLevel>) ||
  model<IInventoryLevel>('InventoryLevel', InventoryLevelSchema);







