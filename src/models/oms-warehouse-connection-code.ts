import { Schema, model, models, Model, Document, Types } from 'mongoose';

export type ConnectionCodeStatus = 'pending' | 'redeemed' | 'expired' | 'revoked';

export interface IOmsWarehouseConnectionCode extends Document {
  code: string;
  warehouseCode: string;
  wmsIntermediaryId: Types.ObjectId; // Facility owner User ID
  omsIntermediaryId?: Types.ObjectId;
  redeemedAt?: Date;
  expiresAt: Date;
  status: ConnectionCodeStatus;
}

const OmsWarehouseConnectionCodeSchema = new Schema<IOmsWarehouseConnectionCode>(
  {
    code: { type: String, required: true, unique: true, index: true },
    warehouseCode: { type: String, required: true, trim: true, index: true },
    wmsIntermediaryId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    omsIntermediaryId: { type: Schema.Types.ObjectId, ref: 'OmsIntermediary', index: true },
    redeemedAt: { type: Date },
    expiresAt: { type: Date, required: true, index: true },
    status: {
      type: String,
      enum: ['pending', 'redeemed', 'expired', 'revoked'],
      default: 'pending',
      index: true,
    },
  },
  { timestamps: true },
);

OmsWarehouseConnectionCodeSchema.index({ code: 1, status: 1 });

export const OmsWarehouseConnectionCode: Model<IOmsWarehouseConnectionCode> =
  (models.OmsWarehouseConnectionCode as Model<IOmsWarehouseConnectionCode>) ||
  model<IOmsWarehouseConnectionCode>('OmsWarehouseConnectionCode', OmsWarehouseConnectionCodeSchema);
