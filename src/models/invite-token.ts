import { Schema, model, models, Model, Document, Types } from 'mongoose';
import { ALL_ROLES, type UserRole } from '../lib/roles';

export interface IInviteToken extends Document {
  token: string;
  role: UserRole;
  expiresAt: Date;
  createdBy: Types.ObjectId;
  usedAt?: Date;
  createdAt?: Date;
  updatedAt?: Date;
}

const InviteTokenSchema = new Schema(
  {
    token: { type: String, required: true, unique: true, index: true },
    role: { type: String, enum: ALL_ROLES, required: true },
    expiresAt: { type: Date, required: true },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    usedAt: { type: Date },
  },
  { timestamps: true }
);

export const InviteToken: Model<IInviteToken> =
  (models.InviteToken as Model<IInviteToken>) || model<IInviteToken>('InviteToken', InviteTokenSchema);
