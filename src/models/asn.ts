import { Schema, model, models, Model, Document, Types } from 'mongoose';

export type ASNStatus = 'new' | 'pending' | 'synced' | 'received' | 'partial' | 'error';

export interface IASNLineItem {
  sku: string;
  quantity: number;
  fnsku?: string;
  expDate?: Date;
}

export interface IASN extends Document {
  shipmentPlanId: Types.ObjectId;
  facilityId: Types.ObjectId;
  userId: Types.ObjectId;
  poNo: string;
  orderDate?: Date;
  lineItems: IASNLineItem[];
  wmsAsnId?: string;
  status: ASNStatus;
}

const ASNLineItemSchema = new Schema<IASNLineItem>(
  {
    sku: { type: String, required: true, trim: true },
    quantity: { type: Number, required: true },
    fnsku: { type: String, trim: true },
    expDate: { type: Date },
  },
  { _id: false },
);

const ASNSchema = new Schema<IASN>(
  {
    shipmentPlanId: { type: Schema.Types.ObjectId, ref: 'ShipmentPlan', required: true, index: true },
    facilityId: { type: Schema.Types.ObjectId, ref: 'Facility', required: true, index: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    poNo: { type: String, required: true, trim: true },
    orderDate: { type: Date },
    lineItems: { type: [ASNLineItemSchema], default: [] },
    wmsAsnId: { type: String, trim: true },
    status: {
      type: String,
      enum: ['new', 'pending', 'synced', 'received', 'partial', 'error'],
      default: 'new',
      index: true,
    },
  },
  { timestamps: true },
);

ASNSchema.index({ userId: 1, createdAt: -1 });

export const ASN: Model<IASN> =
  (models.ASN as Model<IASN>) || model<IASN>('ASN', ASNSchema);
