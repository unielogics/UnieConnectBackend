import { Schema, model, models, Model, Document, Types } from 'mongoose';

export interface ITransportationTemplate extends Document {
  name: string;
  userId: Types.ObjectId;
  supplierId?: Types.ObjectId;
  unitsPerBox: number;
  weightPerBox: number;
  weightPerUnit?: number;
  dimensions?: {
    length?: number; // inches
    width?: number;
    height?: number;
  };
  createdAt?: Date;
  updatedAt?: Date;
}

const TransportationTemplateSchema = new Schema<ITransportationTemplate>(
  {
    name: { type: String, required: true, trim: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    supplierId: { type: Schema.Types.ObjectId, ref: 'Supplier', index: true },
    unitsPerBox: { type: Number, required: true, default: 1 },
    weightPerBox: { type: Number, required: true, default: 0 },
    weightPerUnit: { type: Number },
    dimensions: {
      length: { type: Number },
      width: { type: Number },
      height: { type: Number },
    },
  },
  { timestamps: true },
);

TransportationTemplateSchema.index({ userId: 1, supplierId: 1 });

export const TransportationTemplate: Model<ITransportationTemplate> =
  (models.TransportationTemplate as Model<ITransportationTemplate>) ||
  model<ITransportationTemplate>('TransportationTemplate', TransportationTemplateSchema);
