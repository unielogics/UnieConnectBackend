import { Schema, model, models, Model, Document } from 'mongoose';

export interface IRateShoppingQuote extends Document {
  cityLower: string;
  stateLower: string;
  weightBand: number;
  itemCount: number;
  amount: number;
  currency: string;
  provider?: string;
  raw?: any;
  expiresAt?: Date;
}

const RateShoppingQuoteSchema = new Schema<IRateShoppingQuote>(
  {
    cityLower: { type: String, required: true, index: true },
    stateLower: { type: String, required: true, index: true },
    weightBand: { type: Number, required: true, index: true },
    itemCount: { type: Number, required: true, index: true },
    amount: { type: Number, required: true },
    currency: { type: String, required: true, default: 'USD' },
    provider: { type: String },
    raw: { type: Schema.Types.Mixed },
    expiresAt: { type: Date, index: true },
  },
  { timestamps: true },
);

RateShoppingQuoteSchema.index(
  { cityLower: 1, stateLower: 1, weightBand: 1, itemCount: 1 },
  { unique: true },
);

export const RateShoppingQuote: Model<IRateShoppingQuote> =
  (models.RateShoppingQuote as Model<IRateShoppingQuote>) ||
  model<IRateShoppingQuote>('RateShoppingQuote', RateShoppingQuoteSchema);


