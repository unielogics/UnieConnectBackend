import { Schema, model, models, Model, Document, Types } from 'mongoose';

/**
 * Links an OMS Intermediary to a warehouse and the corresponding WMS Intermediary (User).
 * Used to resolve: (omsIntermediaryId, warehouseCode) -> wmsIntermediaryId (userId)
 * warehouseCode aligns with Facility.code for the WMS User.
 */
export interface IOmsIntermediaryWarehouse extends Document {
  omsIntermediaryId: Types.ObjectId;
  warehouseCode: string;
  wmsIntermediaryId: Types.ObjectId; // User ID - owns WMS data for this warehouse
}

const OmsIntermediaryWarehouseSchema = new Schema<IOmsIntermediaryWarehouse>(
  {
    omsIntermediaryId: { type: Schema.Types.ObjectId, ref: 'OmsIntermediary', required: true, index: true },
    warehouseCode: { type: String, required: true, trim: true, index: true },
    wmsIntermediaryId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true },
);

OmsIntermediaryWarehouseSchema.index({ omsIntermediaryId: 1, warehouseCode: 1 }, { unique: true });
OmsIntermediaryWarehouseSchema.index({ wmsIntermediaryId: 1 });

export const OmsIntermediaryWarehouse: Model<IOmsIntermediaryWarehouse> =
  (models.OmsIntermediaryWarehouse as Model<IOmsIntermediaryWarehouse>) ||
  model<IOmsIntermediaryWarehouse>('OmsIntermediaryWarehouse', OmsIntermediaryWarehouseSchema);
