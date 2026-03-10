import { Schema, model, models, Model, Document, Types } from 'mongoose';

export interface ISupplier extends Document {
  userId: Types.ObjectId;
  name: string;
  onlineSupplier?: boolean;
  email?: string;
  phone?: string;
  hoursOfOperation?: string;
  website?: string;
  notes?: string;
}

const SupplierSchema = new Schema<ISupplier>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    name: { type: String, required: true, trim: true },
    onlineSupplier: { type: Boolean, default: false },
    email: { type: String, trim: true },
    phone: { type: String, trim: true },
    hoursOfOperation: { type: String, trim: true },
    website: { type: String, trim: true },
    notes: { type: String, trim: true },
  },
  { timestamps: true },
);

SupplierSchema.index({ userId: 1, name: 1 });

export const Supplier: Model<ISupplier> = (models.Supplier as Model<ISupplier>) || model<ISupplier>('Supplier', SupplierSchema);
