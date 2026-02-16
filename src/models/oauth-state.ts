import { Schema, model, models, Model, Document, Types } from 'mongoose';

export type OAuthProvider = 'shopify' | 'amazon' | 'ebay';

export interface IOAuthState extends Document {
  provider: OAuthProvider;
  state: string;
  userId: Types.ObjectId;
  tenantId?: string;
  sellerId?: string;
  region?: string;
  redirectTo?: string; // frontend URL to redirect user after OAuth success
  expiresAt: Date;
}

const OAuthStateSchema = new Schema(
  {
    provider: { type: String, required: true },
    state: { type: String, required: true, unique: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    tenantId: { type: String },
    sellerId: { type: String },
    region: { type: String },
    redirectTo: { type: String },
    expiresAt: { type: Date, required: true, index: { expires: 0 } },
  },
  { timestamps: true }
);

export const OAuthState: Model<IOAuthState> =
  (models.OAuthState as Model<IOAuthState>) || model<IOAuthState>('OAuthState', OAuthStateSchema);
