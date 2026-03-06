import { Schema, model, models, Model, Document } from 'mongoose';
import { ALL_ROLES, type UserRole } from '../lib/roles';

export interface IUser extends Document {
  email: string;
  passwordHash: string;
  role: UserRole;
  firstName?: string;
  lastName?: string;
  phone?: string;
  lastLoginAt?: Date;
  resetToken?: string;
  resetTokenExpires?: Date;
  enabledFeatures?: string[]; // Quick access cache of enabled feature slugs
  createdAt?: Date;
  updatedAt?: Date;
}

const UserSchema = new Schema(
  {
    email: { type: String, unique: true, required: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true },
    role: { type: String, enum: ALL_ROLES, default: 'ecommerce_client' },
    firstName: { type: String, trim: true },
    lastName: { type: String, trim: true },
    phone: { type: String, trim: true },
    lastLoginAt: { type: Date },
    resetToken: { type: String },
    resetTokenExpires: { type: Date },
    enabledFeatures: { type: [String], default: [] }, // Cache of enabled feature slugs
  },
  { timestamps: true }
);

export const User: Model<IUser> = (models.User as Model<IUser>) || model<IUser>('User', UserSchema);

