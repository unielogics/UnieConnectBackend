import { Schema, model, models, Model, Document, Types } from 'mongoose';

export type ShipmentPlanStatus =
  | 'draft'
  | 'submitted'
  | 'asn_created'
  | 'in_transit'
  | 'received'
  | 'cancelled';

export type MarketplaceType = 'FBA' | 'FBW';

export interface IShipmentPlanItem {
  sku: string;
  asin?: string;
  title?: string;
  quantity: number;
  boxCount: number;
  unitsPerBox: number;
  expDate?: Date;
  weightPerUnit?: number;
  weightPerBox?: number;
  dimensions?: { width?: number; height?: number; length?: number };
  fnsku?: string;
  upc?: string;
  itemId?: Types.ObjectId; // ref Item when catalog item exists
}

export interface IShipFromAddress {
  name?: string;
  addressLine1?: string;
  addressLine2?: string;
  addressLine3?: string;
  city?: string;
  stateOrProvinceCode?: string;
  postalCode?: string;
  countryCode?: string;
  districtOrCounty?: string;
  phone?: string;
  lat?: number;
  long?: number;
}

export interface IShipmentPlan extends Document {
  internalShipmentId: string;
  userId: Types.ObjectId;
  supplierId: Types.ObjectId;
  shipFromLocationId: Types.ObjectId;
  prepServicesOnly: boolean;
  marketplaceId?: string;
  marketplaceType?: MarketplaceType;
  marketplaceShipmentId?: string;
  marketplacePlanId?: string;
  facilityId?: Types.ObjectId;
  status: ShipmentPlanStatus;
  asnId?: Types.ObjectId;
  items: IShipmentPlanItem[];
  shipFromAddress?: IShipFromAddress;
  orderNo?: string;
  receiptNo?: string;
  orderDate?: Date;
  estimatedArrivalDate?: Date;
  shipmentTitle?: string;
  transportationTemplateId?: Types.ObjectId;
  selectedToWarehouseRate?: Record<string, unknown>;
  selectedToMarketplaceRateId?: string;
  labelIds?: Types.ObjectId[];
  workflowStep?: number;
  wmsAsnId?: string;
}

const ShipmentPlanItemSchema = new Schema<IShipmentPlanItem>(
  {
    sku: { type: String, required: true, trim: true },
    asin: { type: String, trim: true },
    title: { type: String, trim: true },
    quantity: { type: Number, required: true },
    boxCount: { type: Number, required: true },
    unitsPerBox: { type: Number, required: true },
    expDate: { type: Date },
    weightPerUnit: { type: Number },
    weightPerBox: { type: Number },
    dimensions: {
      width: { type: Number },
      height: { type: Number },
      length: { type: Number },
    },
    fnsku: { type: String, trim: true },
    upc: { type: String, trim: true },
    itemId: { type: Schema.Types.ObjectId, ref: 'Item' },
  },
  { _id: false },
);

const ShipFromAddressSchema = new Schema<IShipFromAddress>(
  {
    name: { type: String },
    addressLine1: { type: String },
    addressLine2: { type: String },
    addressLine3: { type: String },
    city: { type: String },
    stateOrProvinceCode: { type: String },
    postalCode: { type: String },
    countryCode: { type: String },
    districtOrCounty: { type: String },
    phone: { type: String },
    lat: { type: Number },
    long: { type: Number },
  },
  { _id: false },
);

const ShipmentPlanSchema = new Schema<IShipmentPlan>(
  {
    internalShipmentId: { type: String, required: true, unique: true, index: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    supplierId: { type: Schema.Types.ObjectId, ref: 'Supplier', required: true, index: true },
    shipFromLocationId: { type: Schema.Types.ObjectId, ref: 'ShipFromLocation', required: true, index: true },
    prepServicesOnly: { type: Boolean, required: true },
    marketplaceId: { type: String },
    marketplaceType: { type: String, enum: ['FBA', 'FBW'] },
    marketplaceShipmentId: { type: String },
    marketplacePlanId: { type: String },
    facilityId: { type: Schema.Types.ObjectId, ref: 'Facility', index: true },
    status: {
      type: String,
      enum: ['draft', 'submitted', 'asn_created', 'in_transit', 'received', 'cancelled'],
      default: 'draft',
      index: true,
    },
    asnId: { type: Schema.Types.ObjectId, ref: 'ASN', index: true },
    items: { type: [ShipmentPlanItemSchema], default: [] },
    shipFromAddress: { type: ShipFromAddressSchema },
    orderNo: { type: String, trim: true },
    receiptNo: { type: String, trim: true },
    orderDate: { type: Date },
    estimatedArrivalDate: { type: Date },
    shipmentTitle: { type: String, trim: true },
    transportationTemplateId: { type: Schema.Types.ObjectId, ref: 'TransportationTemplate', index: true },
    selectedToWarehouseRate: { type: Schema.Types.Mixed },
    selectedToMarketplaceRateId: { type: String },
    labelIds: [{ type: Schema.Types.ObjectId }],
    workflowStep: { type: Number },
    wmsAsnId: { type: String },
  },
  { timestamps: true },
);

ShipmentPlanSchema.index({ userId: 1, status: 1 });
ShipmentPlanSchema.index({ userId: 1, createdAt: -1 });

export const ShipmentPlan: Model<IShipmentPlan> =
  (models.ShipmentPlan as Model<IShipmentPlan>) || model<IShipmentPlan>('ShipmentPlan', ShipmentPlanSchema);
