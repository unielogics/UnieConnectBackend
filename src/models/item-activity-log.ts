import { Schema, model, models, Model, Document, Types } from 'mongoose';

export type ItemActivityAction =
  | 'added_to_shipment'
  | 'removed_from_shipment'
  | 'shipment_created'
  | 'shipment_updated'
  | 'asn_line_created';

export interface IItemActivityLog extends Document {
  itemId?: Types.ObjectId;
  userId: Types.ObjectId;
  sku: string;
  action: ItemActivityAction;
  shipmentPlanId?: Types.ObjectId;
  internalShipmentId?: string;
  metadata?: Record<string, unknown>;
}

const ItemActivityLogSchema = new Schema<IItemActivityLog>(
  {
    itemId: { type: Schema.Types.ObjectId, ref: 'Item', index: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    sku: { type: String, required: true, index: true },
    action: { type: String, required: true, index: true },
    shipmentPlanId: { type: Schema.Types.ObjectId, ref: 'ShipmentPlan', index: true },
    internalShipmentId: { type: String, index: true },
    metadata: { type: Schema.Types.Mixed },
  },
  { timestamps: true },
);

ItemActivityLogSchema.index({ itemId: 1, createdAt: -1 });
ItemActivityLogSchema.index({ sku: 1, userId: 1, createdAt: -1 });
ItemActivityLogSchema.index({ shipmentPlanId: 1, createdAt: -1 });

export const ItemActivityLog: Model<IItemActivityLog> =
  (models.ItemActivityLog as Model<IItemActivityLog>) ||
  model<IItemActivityLog>('ItemActivityLog', ItemActivityLogSchema);
