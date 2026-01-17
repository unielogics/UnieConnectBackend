import { Schema, model, models, Model, Document, Types } from 'mongoose';

export interface IOrderLine extends Document {
  orderId: Types.ObjectId;
  itemId?: Types.ObjectId;
  sku?: string;
  externalLineId?: string;
  quantity: number;
  price?: number;
  tax?: number;
  discounts?: number;
  fulfillmentStatus?: string;
}

const OrderLineSchema = new Schema<IOrderLine>(
  {
    orderId: { type: Schema.Types.ObjectId, ref: 'Order', required: true, index: true },
    itemId: { type: Schema.Types.ObjectId, ref: 'Item' },
    sku: { type: String },
    externalLineId: { type: String },
    quantity: { type: Number, required: true },
    price: { type: Number },
    tax: { type: Number },
    discounts: { type: Number },
    fulfillmentStatus: { type: String },
  },
  { timestamps: true },
);

OrderLineSchema.index({ orderId: 1, externalLineId: 1 }, { unique: false, sparse: true });

export const OrderLine: Model<IOrderLine> =
  (models.OrderLine as Model<IOrderLine>) || model<IOrderLine>('OrderLine', OrderLineSchema);







