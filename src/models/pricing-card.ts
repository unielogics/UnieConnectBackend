import { Schema, model, models, Model, Document, Types } from 'mongoose';

export interface IPrepServiceRate {
  key: string; // e.g. polyBag, bubbleWrap, rebox, bundling, hazmat
  pricePerItem?: number;
  pricePerBox?: number;
}

export interface IPricingCard extends Document {
  facilityId: Types.ObjectId;
  userId: Types.ObjectId;
  costPerBox: number;
  costPerUnit: number;
  labeling: number; // per item
  prepServices: IPrepServiceRate[];
  isDefault?: boolean;
}

const PrepServiceRateSchema = new Schema<IPrepServiceRate>(
  {
    key: { type: String, required: true, trim: true },
    pricePerItem: { type: Number },
    pricePerBox: { type: Number },
  },
  { _id: false },
);

const PricingCardSchema = new Schema<IPricingCard>(
  {
    facilityId: { type: Schema.Types.ObjectId, ref: 'Facility', required: true, index: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    costPerBox: { type: Number, default: 0 },
    costPerUnit: { type: Number, default: 0 },
    labeling: { type: Number, default: 0 },
    prepServices: { type: [PrepServiceRateSchema], default: [] },
    isDefault: { type: Boolean, default: false },
  },
  { timestamps: true },
);

PricingCardSchema.index({ facilityId: 1 }, { unique: true });
PricingCardSchema.index({ userId: 1 });

export const PricingCard: Model<IPricingCard> =
  (models.PricingCard as Model<IPricingCard>) || model<IPricingCard>('PricingCard', PricingCardSchema);
