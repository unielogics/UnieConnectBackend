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
  },
  { timestamps: true },
);

ItemSchema.index({ userId: 1, sku: 1 }, { unique: true });

export const Item: Model<IItem> = (models.Item as Model<IItem>) || model<IItem>('Item', ItemSchema);
















