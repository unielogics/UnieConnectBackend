import { Schema, model, models, Model, Document, Types } from 'mongoose';

export interface IInboundShipmentItem {
  sellerSku: string;
  asin?: string;
  title?: string;
  quantityPlanned?: number;
  quantityShipped: number;
  quantityInCase?: number;
  boxCount?: number;
  unitsPerBox?: number;
  packingTemplateName?: string;
  packingTemplateType?: string;
  packingGroupId?: string;
  packingStatus?: 'missing_inputs' | 'ready';
  packingNote?: string;
  prepDetails?: any;
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
}

export interface IInboundShipment extends Document {
  userId: Types.ObjectId;
  channelAccountId: Types.ObjectId;
  workflowId: string;
  channel?: string;
  marketplaceId?: string;
  shipmentId?: string;
  planId?: string;
  destinationFulfillmentCenterId?: string;
  packingMode?: string;
  workflowStatus?: 'draft' | 'packaging_ready' | 'sku_labels_ready' | 'placement_ready' | 'shipment_confirmed' | 'box_labels_ready';
  labelPrepPreference?: string;
  selectedPlacementOption?: string;
  shipmentName?: string;
  status?: string;
  supplierId?: Types.ObjectId;
  shipFromLocationId?: Types.ObjectId;
  shipFromAddress?: IShipFromAddress;
  items: IInboundShipmentItem[];
  placementOptions?: any[];
  rawPlan?: any;
  rawShipment?: any;
  skuLabels?: {
    requestedAt?: Date;
    fetchedAt?: Date;
    itemCount?: number;
    note?: string;
    items?: Array<{
      sellerSku: string;
      asin?: string;
      title?: string;
      quantity?: number;
    }>;
  };
  boxLabels?: {
    url?: string;
    pageType?: string;
    labelType?: string;
    fetchedAt?: Date;
  };
  labels?: {
    url?: string;
    pageType?: string;
    labelType?: string;
    fetchedAt?: Date;
  };
}

const InboundShipmentItemSchema = new Schema<IInboundShipmentItem>(
  {
    sellerSku: { type: String, required: true },
    asin: { type: String },
    title: { type: String },
    quantityPlanned: { type: Number },
    quantityShipped: { type: Number, required: true },
    quantityInCase: { type: Number },
    boxCount: { type: Number },
    unitsPerBox: { type: Number },
    packingTemplateName: { type: String },
    packingTemplateType: { type: String },
    packingGroupId: { type: String },
    packingStatus: { type: String, enum: ['missing_inputs', 'ready'] },
    packingNote: { type: String },
    prepDetails: { type: Schema.Types.Mixed },
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
  },
  { _id: false },
);

const InboundShipmentSchema = new Schema<IInboundShipment>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    channelAccountId: { type: Schema.Types.ObjectId, ref: 'ChannelAccount', required: true, index: true },
    workflowId: { type: String, required: true, index: true },
    channel: { type: String, index: true },
    marketplaceId: { type: String, index: true },
    shipmentId: { type: String },
    planId: { type: String },
    destinationFulfillmentCenterId: { type: String },
    packingMode: { type: String },
    workflowStatus: {
      type: String,
      enum: ['draft', 'packaging_ready', 'sku_labels_ready', 'placement_ready', 'shipment_confirmed', 'box_labels_ready'],
      default: 'draft',
    },
    labelPrepPreference: { type: String },
    selectedPlacementOption: { type: String },
    shipmentName: { type: String },
    status: { type: String },
    supplierId: { type: Schema.Types.ObjectId, ref: 'Supplier', index: true },
    shipFromLocationId: { type: Schema.Types.ObjectId, ref: 'ShipFromLocation', index: true },
    shipFromAddress: { type: ShipFromAddressSchema },
    items: { type: [InboundShipmentItemSchema], default: [] },
    placementOptions: { type: [Schema.Types.Mixed], default: [] },
    rawPlan: { type: Schema.Types.Mixed },
    rawShipment: { type: Schema.Types.Mixed },
    skuLabels: {
      requestedAt: { type: Date },
      fetchedAt: { type: Date },
      itemCount: { type: Number },
      note: { type: String },
      items: {
        type: [
          new Schema(
            {
              sellerSku: { type: String, required: true },
              asin: { type: String },
              title: { type: String },
              quantity: { type: Number },
            },
            { _id: false },
          ),
        ],
        default: [],
      },
    },
    boxLabels: {
      url: { type: String },
      pageType: { type: String },
      labelType: { type: String },
      fetchedAt: { type: Date },
    },
    labels: {
      url: { type: String },
      pageType: { type: String },
      labelType: { type: String },
      fetchedAt: { type: Date },
    },
  },
  { timestamps: true },
);

InboundShipmentSchema.index({ channelAccountId: 1, workflowId: 1 });
InboundShipmentSchema.index(
  { channelAccountId: 1, shipmentId: 1 },
  { unique: true, partialFilterExpression: { shipmentId: { $exists: true, $type: 'string' } } },
);

export const InboundShipment: Model<IInboundShipment> =
  (models.InboundShipment as Model<IInboundShipment>) ||
  model<IInboundShipment>('InboundShipment', InboundShipmentSchema);


