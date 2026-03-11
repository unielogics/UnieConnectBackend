import { Schema, model, models, Model, Document, Types } from 'mongoose';

export type OmsIntermediaryStatus = 'active' | 'inactive' | 'suspended';

export interface IOmsIntermediary extends Document {
  companyName: string;
  email: string;
  status: OmsIntermediaryStatus;
}

const OmsIntermediarySchema = new Schema<IOmsIntermediary>(
  {
    companyName: { type: String, required: true, trim: true },
    email: { type: String, required: true, lowercase: true, trim: true, index: true },
    status: { type: String, enum: ['active', 'inactive', 'suspended'], default: 'active', index: true },
  },
  { timestamps: true },
);

export const OmsIntermediary: Model<IOmsIntermediary> =
  (models.OmsIntermediary as Model<IOmsIntermediary>) ||
  model<IOmsIntermediary>('OmsIntermediary', OmsIntermediarySchema);
