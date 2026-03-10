import { Schema, model, models, Model, Document, Types } from 'mongoose';

export interface IShipFromLocationAddress {
  addressLine1: string;
  addressLine2?: string;
  addressLine3?: string;
  city: string;
  stateOrProvinceCode: string;
  postalCode: string;
  countryCode: string;
  districtOrCounty?: string;
  lat?: number;
  long?: number;
}

export interface IShipFromLocation extends Document {
  userId: Types.ObjectId;
  supplierId: Types.ObjectId;
  label: string;
  contactName?: string;
  email?: string;
  phone?: string;
  hoursOfOperation?: string;
  website?: string;
  address: IShipFromLocationAddress;
  isDefault?: boolean;
}

const ShipFromLocationAddressSchema = new Schema<IShipFromLocationAddress>(
  {
    addressLine1: { type: String, required: true, trim: true },
    addressLine2: { type: String, trim: true },
    addressLine3: { type: String, trim: true },
    city: { type: String, required: true, trim: true },
    stateOrProvinceCode: { type: String, required: true, trim: true },
    postalCode: { type: String, required: true, trim: true },
    countryCode: { type: String, required: true, trim: true },
    districtOrCounty: { type: String, trim: true },
    lat: { type: Number },
    long: { type: Number },
  },
  { _id: false },
);

const ShipFromLocationSchema = new Schema<IShipFromLocation>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    supplierId: { type: Schema.Types.ObjectId, ref: 'Supplier', required: true, index: true },
    label: { type: String, required: true, trim: true },
    contactName: { type: String, trim: true },
    email: { type: String, trim: true },
    phone: { type: String, trim: true },
    hoursOfOperation: { type: String, trim: true },
    website: { type: String, trim: true },
    address: { type: ShipFromLocationAddressSchema, required: true },
    isDefault: { type: Boolean, default: false },
  },
  { timestamps: true },
);

ShipFromLocationSchema.index({ userId: 1, supplierId: 1, label: 1 });

export const ShipFromLocation: Model<IShipFromLocation> =
  (models.ShipFromLocation as Model<IShipFromLocation>) || model<IShipFromLocation>('ShipFromLocation', ShipFromLocationSchema);
