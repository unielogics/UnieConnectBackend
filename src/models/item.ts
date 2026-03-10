import { Schema, model, models, Model, Document, Types } from 'mongoose';

export interface IItem extends Document {
  userId: Types.ObjectId;
  sku: string;
  title: string;
  description?: string;
  attributes?: Record<string, string>;
  defaultUom?: string;
  tags?: string[];
  archived: boolean;
  supplierId?: Types.ObjectId;
  image?: string;
  images?: string[];
  upc?: string;
  ean?: string;
  asin?: string;
  category?: string;
  subCategory?: string;
  lob?: string;
  weight?: number;
  dimensions?: { length: number; width: number; height: number };
}

const ItemSchema = new Schema<IItem>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    sku: { type: String, required: true, trim: true },
    title: { type: String, required: true, trim: true },
    description: { type: String },
    attributes: { type: Schema.Types.Mixed },
    defaultUom: { type: String },
    tags: [{ type: String }],
    archived: { type: Boolean, default: false },
    supplierId: { type: Schema.Types.ObjectId, ref: 'Supplier', index: true },
    image: { type: String },
    images: [{ type: String }],
    upc: { type: String },
    ean: { type: String },
    asin: { type: String },
    category: { type: String },
    subCategory: { type: String },
    lob: { type: String },
    weight: { type: Number },
    dimensions: {
      length: { type: Number },
      width: { type: Number },
      height: { type: Number },
    },
  },
  { timestamps: true },
);

ItemSchema.index({ userId: 1, sku: 1 }, { unique: true });
ItemSchema.index({ userId: 1, supplierId: 1 });

export const Item: Model<IItem> = (models.Item as Model<IItem>) || model<IItem>('Item', ItemSchema);
















