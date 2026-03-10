import { Schema, model, models, Model, Document, Types } from 'mongoose';

export interface IFacilityAddress {
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

export interface IFacility extends Document {
  userId: Types.ObjectId;
  name: string;
  code: string;
  address: IFacilityAddress;
  status?: string;
  isActive: boolean;
}

const FacilityAddressSchema = new Schema<IFacilityAddress>(
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

const FacilitySchema = new Schema<IFacility>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    name: { type: String, required: true, trim: true },
    code: { type: String, required: true, trim: true },
    address: { type: FacilityAddressSchema, required: true },
    status: { type: String, default: 'active', trim: true },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true },
);

FacilitySchema.index({ userId: 1, code: 1 }, { unique: true });
FacilitySchema.index({ userId: 1, isActive: 1 });

export const Facility: Model<IFacility> =
  (models.Facility as Model<IFacility>) || model<IFacility>('Facility', FacilitySchema);
