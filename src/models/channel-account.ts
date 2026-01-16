import { Schema, model, models, Model, Document, Types } from 'mongoose';

export interface IChannelAccount extends Document {
  userId: Types.ObjectId;
  channel: string;
  shopDomain?: string;
  externalSellerId?: string; // eBay seller username or external seller id when available
  accessToken: string;
  refreshToken?: string;
  expiresAt?: Date;
  lastCronAt?: Date;
  flags: {
    ordersIn: boolean;
    inventoryOut: boolean;
    fulfillmentOut: boolean;
    labels: boolean;
  };
  status: string;
  // Amazon SP-API fields
  marketplaceIds?: string[];
  sellingPartnerId?: string;
  region?: string;
  lwaRefreshToken?: string;
  lwaAccessToken?: string;
  lwaAccessTokenExpiresAt?: Date;
  roleArn?: string;
}

const ChannelAccountSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    channel: { type: String, required: true }, // shopify, amazon, etc.
    shopDomain: { type: String },
    accessToken: { type: String, required: true },
    refreshToken: { type: String },
    expiresAt: { type: Date },
    lastCronAt: { type: Date },
    flags: {
      ordersIn: { type: Boolean, default: true },
      inventoryOut: { type: Boolean, default: true },
      fulfillmentOut: { type: Boolean, default: true },
      labels: { type: Boolean, default: false },
    },
    status: { type: String, default: 'active' },
    marketplaceIds: { type: [String], default: [] },
    sellingPartnerId: { type: String },
    region: { type: String },
    lwaRefreshToken: { type: String },
    lwaAccessToken: { type: String },
    lwaAccessTokenExpiresAt: { type: Date },
    roleArn: { type: String },
  },
  { timestamps: true }
);

export const ChannelAccount: Model<IChannelAccount> =
  (models.ChannelAccount as Model<IChannelAccount>) ||
  model<IChannelAccount>('ChannelAccount', ChannelAccountSchema);
export type ChannelType = 'shopify' | 'amazon' | 'ebay' | 'tiktok' | 'elsy' | 'wayfair';

export type ChannelFeatureFlags = {
  ordersIn: boolean;
  inventoryOut: boolean;
  fulfillmentOut: boolean;
  labels?: boolean;
};

export type ChannelAccount = {
  id: string;
  tenantId: string; // seller/user id in UnieConnect
  channel: ChannelType;
  shopDomain?: string; // Shopify domain
  webhookSecret?: string; // per-account secret if used
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: string;
  flags: ChannelFeatureFlags;
  status: 'active' | 'inactive';
  // Amazon SP-API fields
  marketplaceIds?: string[];
  sellingPartnerId?: string;
  region?: string; // na, eu, fe
  lwaRefreshToken?: string;
  lwaAccessToken?: string;
  lwaAccessTokenExpiresAt?: string;
  roleArn?: string;
  createdAt: string;
  updatedAt: string;
};

