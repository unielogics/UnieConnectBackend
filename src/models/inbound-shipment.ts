import { Schema, model, models, Model, Document, Types } from 'mongoose';

export interface IInboundShipmentItem {
  sellerSku: string;
  quantityShipped: number;
  quantityInCase?: number;
  prepDetails?: any;
}

export interface IInboundShipment extends Document {
  userId: Types.ObjectId;
  channelAccountId: Types.ObjectId;
  channel?: string;
  marketplaceId?: string;
  shipmentId: string;
  planId?: string;
  destinationFulfillmentCenterId?: string;
  labelPrepPreference?: string;
  shipmentName?: string;
  status?: string;
  items: IInboundShipmentItem[];
  rawPlan?: any;
  rawShipment?: any;
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
    quantityShipped: { type: Number, required: true },
    quantityInCase: { type: Number },
    prepDetails: { type: Schema.Types.Mixed },
  },
  { _id: false },
);

const InboundShipmentSchema = new Schema<IInboundShipment>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    channelAccountId: { type: Schema.Types.ObjectId, ref: 'ChannelAccount', required: true, index: true },
    channel: { type: String, index: true },
    marketplaceId: { type: String, index: true },
    shipmentId: { type: String, required: true },
    planId: { type: String },
    destinationFulfillmentCenterId: { type: String },
    labelPrepPreference: { type: String },
    shipmentName: { type: String },
    status: { type: String },
    items: { type: [InboundShipmentItemSchema], default: [] },
    rawPlan: { type: Schema.Types.Mixed },
    rawShipment: { type: Schema.Types.Mixed },
    labels: {
      url: { type: String },
      pageType: { type: String },
      labelType: { type: String },
      fetchedAt: { type: Date },
    },
  },
  { timestamps: true },
);

InboundShipmentSchema.index({ channelAccountId: 1, shipmentId: 1 }, { unique: true });

export const InboundShipment: Model<IInboundShipment> =
  (models.InboundShipment as Model<IInboundShipment>) ||
  model<IInboundShipment>('InboundShipment', InboundShipmentSchema);


