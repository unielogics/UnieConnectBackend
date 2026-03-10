import { Schema, model, models, Model, Document, Types } from 'mongoose';

export type ShipmentActivityAction =
  | 'created'
  | 'updated'
  | 'submitted'
  | 'cancelled'
  | 'asn_created'
  | 'status_changed'
  | 'fba_confirmed';

export interface IShipmentActivityLog extends Document {
  userId: Types.ObjectId;
  shipmentPlanId?: Types.ObjectId;
  internalShipmentId: string;
  action: ShipmentActivityAction;
  metadata?: Record<string, unknown>;
}

const ShipmentActivityLogSchema = new Schema<IShipmentActivityLog>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    shipmentPlanId: { type: Schema.Types.ObjectId, ref: 'ShipmentPlan', index: true },
    internalShipmentId: { type: String, required: true, index: true },
    action: { type: String, required: true, index: true },
    metadata: { type: Schema.Types.Mixed },
  },
  { timestamps: true },
);

ShipmentActivityLogSchema.index({ shipmentPlanId: 1, createdAt: -1 });
ShipmentActivityLogSchema.index({ userId: 1, createdAt: -1 });
ShipmentActivityLogSchema.index({ internalShipmentId: 1, createdAt: -1 });

export const ShipmentActivityLog: Model<IShipmentActivityLog> =
  (models.ShipmentActivityLog as Model<IShipmentActivityLog>) ||
  model<IShipmentActivityLog>('ShipmentActivityLog', ShipmentActivityLogSchema);
