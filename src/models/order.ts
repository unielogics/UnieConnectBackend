import { Schema, model, models, Model, Document, Types } from 'mongoose';

export interface IOrderTotals {
  subtotal?: number;
  tax?: number;
  shipping?: number;
  discounts?: number;
  total?: number;
}

export interface IOrder extends Document {
  userId: Types.ObjectId;
  channelAccountId: Types.ObjectId;
  channel: string;
  marketplaceId?: string;
  fulfillmentChannel?: string; // MFN/AFN/etc.
  source?: string; // poll/webhook/manual
  externalOrderId: string;
  status: string;
  currency?: string;
  totals?: IOrderTotals;
  customerId?: Types.ObjectId;
  placedAt?: Date;
  closedAt?: Date;
  raw?: any;
  syncedAt?: Date;
}

const OrderSchema = new Schema<IOrder>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    channelAccountId: { type: Schema.Types.ObjectId, ref: 'ChannelAccount', required: true, index: true },
    channel: { type: String, required: true, index: true },
    marketplaceId: { type: String },
    fulfillmentChannel: { type: String },
    source: { type: String },
    externalOrderId: { type: String, required: true },
    status: { type: String, default: 'open' },
    currency: { type: String },
    totals: {
      subtotal: Number,
      tax: Number,
      shipping: Number,
      discounts: Number,
      total: Number,
    },
    customerId: { type: Schema.Types.ObjectId, ref: 'Customer' },
    placedAt: { type: Date },
    closedAt: { type: Date },
    raw: { type: Schema.Types.Mixed },
    syncedAt: { type: Date },
  },
  { timestamps: true },
);

OrderSchema.index({ channelAccountId: 1, externalOrderId: 1 }, { unique: true });

export const Order: Model<IOrder> = (models.Order as Model<IOrder>) || model<IOrder>('Order', OrderSchema);


