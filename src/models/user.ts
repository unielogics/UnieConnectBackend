import { Schema, model, models, Model, Document } from 'mongoose';
import { ALL_ROLES, type UserRole } from '../lib/roles';

export interface IBillingAddress {
  addressLine1?: string;
  addressLine2?: string;
  city?: string;
  state?: string;
  zipCode?: string;
  country?: string;
}

export interface IUser extends Document {
  email: string;
  passwordHash: string;
  role: UserRole;
  firstName?: string;
  lastName?: string;
  phone?: string;
  llcName?: string;
  billingAddress?: IBillingAddress;
  lastLoginAt?: Date;
  resetToken?: string;
  resetTokenExpires?: Date;
  enabledFeatures?: string[]; // Quick access cache of enabled feature slugs
  createdAt?: Date;
  updatedAt?: Date;
}

const BillingAddressSchema = new Schema(
  {
    addressLine1: { type: String, trim: true },
    addressLine2: { type: String, trim: true },
    city: { type: String, trim: true },
    state: { type: String, trim: true },
    zipCode: { type: String, trim: true },
    country: { type: String, trim: true },
  },
  { _id: false }
);

const UserSchema = new Schema(
  {
    email: { type: String, unique: true, required: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true },
    role: { type: String, enum: ALL_ROLES, default: 'ecommerce_client' },
    firstName: { type: String, trim: true },
    lastName: { type: String, trim: true },
    phone: { type: String, trim: true },
    llcName: { type: String, trim: true },
    billingAddress: { type: BillingAddressSchema },
    lastLoginAt: { type: Date },
    resetToken: { type: String },
    resetTokenExpires: { type: Date },
    enabledFeatures: { type: [String], default: [] }, // Cache of enabled feature slugs
  },
  { timestamps: true }
);

export const User: Model<IUser> = (models.User as Model<IUser>) || model<IUser>('User', UserSchema);

