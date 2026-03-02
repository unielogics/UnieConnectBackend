import { Schema, model, models, Model, Document } from 'mongoose';

export interface IFeature extends Document {
  name: string;
  slug: string;
  description: string;
  longDescription?: string;
  category: string;
  icon?: string;
  screenshots?: string[];
  pricing: {
    type: 'free' | 'one-time' | 'subscription';
    amount?: number;
    currency?: string;
    trialDays?: number;
  };
  tags: string[];
  searchKeywords: string[];
  isActive: boolean;
  isStandard: boolean; // Always available features
  requiredFeatures?: string[]; // Feature dependencies
  version: string;
  author: string;
  metadata: {
    route?: string;
    permissions?: string[];
    navLabel?: string;
    navIcon?: string;
    navOrder?: number;
  };
}

const FeatureSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    slug: { type: String, required: true, unique: true, lowercase: true, trim: true },
    description: { type: String, required: true },
    longDescription: { type: String },
    category: { type: String, required: true, index: true }, // e.g., 'integration', 'automation', 'analytics'
    icon: { type: String },
    screenshots: { type: [String], default: [] },
    pricing: {
      type: {
        type: String,
        enum: ['free', 'one-time', 'subscription'],
        default: 'free',
        required: true,
      },
      amount: { type: Number },
      currency: { type: String, default: 'USD' },
      trialDays: { type: Number, default: 0 },
    },
    tags: { type: [String], default: [] },
    searchKeywords: { type: [String], default: [], index: true },
    isActive: { type: Boolean, default: true, index: true },
    isStandard: { type: Boolean, default: false, index: true },
    requiredFeatures: { type: [String], default: [] },
    version: { type: String, default: '1.0.0' },
    author: { type: String, default: 'UnieConnect' },
    metadata: {
      route: { type: String },
      permissions: { type: [String], default: [] },
      navLabel: { type: String },
      navIcon: { type: String },
      navOrder: { type: Number, default: 0 },
    },
  },
  { timestamps: true }
);

// Index for search
FeatureSchema.index({ name: 'text', description: 'text', searchKeywords: 'text' });

export const Feature: Model<IFeature> =
  (models.Feature as Model<IFeature>) || model<IFeature>('Feature', FeatureSchema);
