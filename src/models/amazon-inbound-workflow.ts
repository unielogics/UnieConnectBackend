import { Schema, model, models, Model, Document, Types } from 'mongoose';

export type AmazonWorkflowStatus =
  | 'draft'
  | 'packing_ready'
  | 'placement_generated'
  | 'placement_confirmed'
  | 'shipment_confirmed'
  | 'labels_ready'
  | 'error';

export interface IAmazonInboundWorkflowItem {
  sellerSku: string;
  asin?: string;
  title?: string;
  availableQuantity?: number;
  quantity: number;
  packingMode: 'individual' | 'case_packed';
  cartonCount?: number;
  unitsPerCarton?: number;
  prepOwner?: 'AMAZON' | 'SELLER';
  labelOwner?: 'AMAZON' | 'SELLER';
  status: 'selected' | 'needs_input' | 'ready' | 'error';
  issues: string[];
}

export interface IAmazonInboundWorkflowCarton {
  cartonId: string;
  cartonName: string;
  packingGroupId?: string;
  quantity: number;
  unitsPerCarton: number;
  contentSource: 'BOX_CONTENT_PROVIDED';
  items: Array<{
    sellerSku: string;
    quantity: number;
  }>;
}

export interface IAmazonPlacementShipment {
  shipmentId?: string;
  shipmentName?: string;
  destinationFulfillmentCenterId?: string;
  items: Array<{
    sellerSku: string;
    quantity: number;
  }>;
}

export interface IAmazonPlacementOption {
  placementOptionId: string;
  status?: string;
  preference?: string;
  fees?: any;
  discounts?: any;
  shipments: IAmazonPlacementShipment[];
  raw?: any;
}

export interface IAmazonShipmentRecord {
  shipmentId: string;
  shipmentName?: string;
  destinationFulfillmentCenterId?: string;
  status?: string;
  items: Array<{
    sellerSku: string;
    quantity: number;
  }>;
  boxes?: any[];
  labels?: {
    boxLabelUrl?: string;
    fetchedAt?: Date;
    raw?: any;
  };
  raw?: any;
}

export interface IAmazonWorkflowDocument extends Document {
  userId: Types.ObjectId;
  channelAccountId: Types.ObjectId;
  workflowId: string;
  workflowName?: string;
  marketplaceId?: string;
  workflowStatus: AmazonWorkflowStatus;
  shipFromLocationId?: Types.ObjectId;
  shipFromAddress?: {
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
  };
  items: IAmazonInboundWorkflowItem[];
  cartons: IAmazonInboundWorkflowCarton[];
  placementOptions: IAmazonPlacementOption[];
  selectedPlacementOptionId?: string;
  shipments: IAmazonShipmentRecord[];
  warnings: string[];
  workflowErrors: string[];
  amazonReferences?: {
    inboundPlanId?: string;
    packingOptionId?: string;
    createPlanOperationId?: string;
    generatePackingOperationId?: string;
    confirmPackingOperationId?: string;
    generatePlacementOperationId?: string;
    confirmPlacementOperationId?: string;
  };
  raw?: {
    createInboundPlan?: any;
    packingOptions?: any;
    placementOptions?: any;
  };
}

const ShipFromAddressSchema = new Schema(
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

const WorkflowItemSchema = new Schema<IAmazonInboundWorkflowItem>(
  {
    sellerSku: { type: String, required: true },
    asin: { type: String },
    title: { type: String },
    availableQuantity: { type: Number },
    quantity: { type: Number, required: true },
    packingMode: { type: String, enum: ['individual', 'case_packed'], required: true },
    cartonCount: { type: Number },
    unitsPerCarton: { type: Number },
    prepOwner: { type: String, enum: ['AMAZON', 'SELLER'] },
    labelOwner: { type: String, enum: ['AMAZON', 'SELLER'] },
    status: { type: String, enum: ['selected', 'needs_input', 'ready', 'error'], required: true },
    issues: { type: [String], default: [] },
  },
  { _id: false },
);

const CartonSchema = new Schema<IAmazonInboundWorkflowCarton>(
  {
    cartonId: { type: String, required: true },
    cartonName: { type: String, required: true },
    packingGroupId: { type: String },
    quantity: { type: Number, required: true },
    unitsPerCarton: { type: Number, required: true },
    contentSource: { type: String, enum: ['BOX_CONTENT_PROVIDED'], default: 'BOX_CONTENT_PROVIDED' },
    items: {
      type: [
        new Schema(
          {
            sellerSku: { type: String, required: true },
            quantity: { type: Number, required: true },
          },
          { _id: false },
        ),
      ],
      default: [],
    },
  },
  { _id: false },
);

const PlacementShipmentSchema = new Schema<IAmazonPlacementShipment>(
  {
    shipmentId: { type: String },
    shipmentName: { type: String },
    destinationFulfillmentCenterId: { type: String },
    items: {
      type: [
        new Schema(
          {
            sellerSku: { type: String, required: true },
            quantity: { type: Number, required: true },
          },
          { _id: false },
        ),
      ],
      default: [],
    },
  },
  { _id: false },
);

const PlacementOptionSchema = new Schema<IAmazonPlacementOption>(
  {
    placementOptionId: { type: String, required: true },
    status: { type: String },
    preference: { type: String },
    fees: { type: Schema.Types.Mixed },
    discounts: { type: Schema.Types.Mixed },
    shipments: { type: [PlacementShipmentSchema], default: [] },
    raw: { type: Schema.Types.Mixed },
  },
  { _id: false },
);

const ShipmentRecordSchema = new Schema<IAmazonShipmentRecord>(
  {
    shipmentId: { type: String, required: true },
    shipmentName: { type: String },
    destinationFulfillmentCenterId: { type: String },
    status: { type: String },
    items: {
      type: [
        new Schema(
          {
            sellerSku: { type: String, required: true },
            quantity: { type: Number, required: true },
          },
          { _id: false },
        ),
      ],
      default: [],
    },
    boxes: { type: [Schema.Types.Mixed], default: [] },
    labels: {
      boxLabelUrl: { type: String },
      fetchedAt: { type: Date },
      raw: { type: Schema.Types.Mixed },
    },
    raw: { type: Schema.Types.Mixed },
  },
  { _id: false },
);

const AmazonInboundWorkflowSchema = new Schema<IAmazonWorkflowDocument>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    channelAccountId: { type: Schema.Types.ObjectId, ref: 'ChannelAccount', required: true, index: true },
    workflowId: { type: String, required: true, index: true },
    workflowName: { type: String },
    marketplaceId: { type: String, index: true },
    workflowStatus: {
      type: String,
      enum: ['draft', 'packing_ready', 'placement_generated', 'placement_confirmed', 'shipment_confirmed', 'labels_ready', 'error'],
      default: 'draft',
      index: true,
    },
    shipFromLocationId: { type: Schema.Types.ObjectId, ref: 'ShipFromLocation', index: true },
    shipFromAddress: { type: ShipFromAddressSchema },
    items: { type: [WorkflowItemSchema], default: [] },
    cartons: { type: [CartonSchema], default: [] },
    placementOptions: { type: [PlacementOptionSchema], default: [] },
    selectedPlacementOptionId: { type: String },
    shipments: { type: [ShipmentRecordSchema], default: [] },
  warnings: { type: [String], default: [] },
  workflowErrors: { type: [String], default: [] },
    amazonReferences: {
      inboundPlanId: { type: String },
      packingOptionId: { type: String },
      createPlanOperationId: { type: String },
      generatePackingOperationId: { type: String },
      confirmPackingOperationId: { type: String },
      generatePlacementOperationId: { type: String },
      confirmPlacementOperationId: { type: String },
    },
    raw: {
      createInboundPlan: { type: Schema.Types.Mixed },
      packingOptions: { type: Schema.Types.Mixed },
      placementOptions: { type: Schema.Types.Mixed },
    },
  },
  { timestamps: true },
);

AmazonInboundWorkflowSchema.index({ channelAccountId: 1, workflowId: 1 }, { unique: true });
AmazonInboundWorkflowSchema.index({ channelAccountId: 1, updatedAt: -1 });

export const AmazonInboundWorkflow: Model<IAmazonWorkflowDocument> =
  (models.AmazonInboundWorkflow as Model<IAmazonWorkflowDocument>) ||
  model<IAmazonWorkflowDocument>('AmazonInboundWorkflow', AmazonInboundWorkflowSchema);
