import { Schema, model, models, Model, Document, Types } from 'mongoose';

export interface IShippingLabel extends Document {
  userId: Types.ObjectId;
  channelAccountId: Types.ObjectId;
  channel?: string;
  marketplaceId?: string;
  orderId?: Types.ObjectId;
  shipmentId: string;
  labelFormat?: string;
  downloadUrl?: string;
  document?: string; // base64 if needed
  mimeType?: string;
  expiresAt?: Date;
  raw?: any;
}

const ShippingLabelSchema = new Schema<IShippingLabel>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    channelAccountId: { type: Schema.Types.ObjectId, ref: 'ChannelAccount', required: true, index: true },
    channel: { type: String, index: true },
    marketplaceId: { type: String, index: true },
    orderId: { type: Schema.Types.ObjectId, ref: 'Order' },
    shipmentId: { type: String, required: true },
    labelFormat: { type: String },
    downloadUrl: { type: String },
    document: { type: String },
    mimeType: { type: String },
    expiresAt: { type: Date },
    raw: { type: Schema.Types.Mixed },
  },
  { timestamps: true },
);

ShippingLabelSchema.index({ channelAccountId: 1, shipmentId: 1 }, { unique: true });

export const ShippingLabel: Model<IShippingLabel> =
  (models.ShippingLabel as Model<IShippingLabel>) || model<IShippingLabel>('ShippingLabel', ShippingLabelSchema);


