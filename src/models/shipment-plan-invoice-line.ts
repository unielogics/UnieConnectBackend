import { Schema, model, models, Model, Document, Types } from 'mongoose';

export type ShipmentPlanInvoiceLineType = 'fulfillment' | 'inventory_services' | 'shipment_plan_services';

export interface IShipmentPlanInvoiceLine extends Document {
  shipmentPlanId: Types.ObjectId;
  userId: Types.ObjectId;
  lineType: ShipmentPlanInvoiceLineType;
  amount: number;
  currency: string;
  description?: string;
  linkedAt: Date;
}

const ShipmentPlanInvoiceLineSchema = new Schema<IShipmentPlanInvoiceLine>(
  {
    shipmentPlanId: { type: Schema.Types.ObjectId, ref: 'ShipmentPlan', required: true, index: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    lineType: {
      type: String,
      enum: ['fulfillment', 'inventory_services', 'shipment_plan_services'],
      required: true,
      index: true,
    },
    amount: { type: Number, required: true },
    currency: { type: String, default: 'USD' },
    description: { type: String },
    linkedAt: { type: Date, default: Date.now },
  },
  { timestamps: true },
);

ShipmentPlanInvoiceLineSchema.index({ shipmentPlanId: 1 });
ShipmentPlanInvoiceLineSchema.index({ userId: 1, linkedAt: -1 });

export const ShipmentPlanInvoiceLine: Model<IShipmentPlanInvoiceLine> =
  (models.ShipmentPlanInvoiceLine as Model<IShipmentPlanInvoiceLine>) ||
  model<IShipmentPlanInvoiceLine>('ShipmentPlanInvoiceLine', ShipmentPlanInvoiceLineSchema);
