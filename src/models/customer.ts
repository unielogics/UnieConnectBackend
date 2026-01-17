import { Schema, model, models, Model, Document, Types } from 'mongoose';

export interface ICustomerAddress {
  line1?: string;
  line2?: string;
  city?: string;
  region?: string;
  postalCode?: string;
  country?: string;
}

export interface ICustomer extends Document {
  userId: Types.ObjectId;
  email?: string;
  phone?: string;
  name?: { first?: string; last?: string };
  addresses?: ICustomerAddress[];
  tags?: string[];
  archived: boolean;
}

const CustomerSchema = new Schema<ICustomer>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    email: { type: String, lowercase: true, trim: true },
    phone: { type: String, trim: true },
    name: {
      first: { type: String, trim: true },
      last: { type: String, trim: true },
    },
    addresses: [
      {
        line1: String,
        line2: String,
        city: String,
        region: String,
        postalCode: String,
        country: String,
      },
    ],
    tags: [{ type: String }],
    archived: { type: Boolean, default: false },
  },
  { timestamps: true },
);

CustomerSchema.index({ userId: 1, email: 1 }, { unique: false, sparse: true });
CustomerSchema.index({ userId: 1, phone: 1 }, { unique: false, sparse: true });

export const Customer: Model<ICustomer> =
  (models.Customer as Model<ICustomer>) || model<ICustomer>('Customer', CustomerSchema);







