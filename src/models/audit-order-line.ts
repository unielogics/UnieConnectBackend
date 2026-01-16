import { Schema, model, models, Model, Document, Types } from 'mongoose';

export interface IAuditOrderLine extends Document {
  userId: Types.ObjectId;
  channelAccountId: Types.ObjectId;
  channel: string;
  marketplaceId?: string;
  fulfillmentChannel?: string;
  source?: string;
  orderId?: Types.ObjectId;
  orderExternalId?: string;
  orderDate?: Date;
  sku?: string;
  itemName?: string;
  quantity?: number;
  weightLbs?: number;
  itemCount?: number;
  shipTo?: {
    city?: string;
    state?: string;
    postalCode?: string;
    country?: string;
  };
  costs?: {
    fulfillment?: number;
    label?: number;
    prep?: number;
    thirdParty?: number;
  };
  prepFeeRequired?: boolean;
  dataQualityStatus?: 'valid' | 'excluded';
  dataQualityReasons?: string[];
  originalCostTotal?: number;
  optimizedCostTotal?: number;
  savingsPct?: number;
  savingsEnabled?: boolean;
  rateShoppingQuoteRef?: string;
  chosenWarehouseId?: string;
  shipZone?: string;
  hotStateRank?: number;
  zoneClusterId?: string;
  demandScore?: number;
  coverageFlags?: {
    multiZoneCapable?: boolean;
  };
}

const AuditOrderLineSchema = new Schema<IAuditOrderLine>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    channelAccountId: { type: Schema.Types.ObjectId, ref: 'ChannelAccount', required: true, index: true },
    channel: { type: String, required: true, index: true },
    marketplaceId: { type: String },
    fulfillmentChannel: { type: String },
    source: { type: String },
    orderId: { type: Schema.Types.ObjectId, ref: 'Order', index: true },
    orderExternalId: { type: String },
    orderDate: { type: Date, index: true },
    sku: { type: String, index: true },
    itemName: { type: String },
    quantity: { type: Number },
    weightLbs: { type: Number },
    itemCount: { type: Number },
    shipTo: {
      city: { type: String },
      state: { type: String, index: true },
      postalCode: { type: String },
      country: { type: String },
    },
    costs: {
      fulfillment: { type: Number },
      label: { type: Number },
      prep: { type: Number },
      thirdParty: { type: Number },
    },
    prepFeeRequired: { type: Boolean, default: true },
    dataQualityStatus: { type: String, enum: ['valid', 'excluded'], default: 'valid', index: true },
    dataQualityReasons: [{ type: String }],
    originalCostTotal: { type: Number },
    optimizedCostTotal: { type: Number },
    savingsPct: { type: Number },
    savingsEnabled: { type: Boolean, default: true, index: true },
    rateShoppingQuoteRef: { type: String },
    chosenWarehouseId: { type: String },
    shipZone: { type: String },
    hotStateRank: { type: Number },
    zoneClusterId: { type: String },
    demandScore: { type: Number },
    coverageFlags: {
      multiZoneCapable: { type: Boolean },
    },
  },
  { timestamps: true },
);

AuditOrderLineSchema.index({ userId: 1, orderId: 1, sku: 1 });
AuditOrderLineSchema.index({ userId: 1, shipZone: 1, orderDate: -1 });

export const AuditOrderLine: Model<IAuditOrderLine> =
  (models.AuditOrderLine as Model<IAuditOrderLine>) || model<IAuditOrderLine>('AuditOrderLine', AuditOrderLineSchema);


