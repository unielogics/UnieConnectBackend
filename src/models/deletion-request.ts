import { Schema, model, models, Model, Document } from 'mongoose';

export interface IDeletionRequest extends Document {
  provider: string; // ebay, amazon, etc.
  externalUserId: string;
  status: 'pending' | 'completed' | 'no_match';
  detail?: string;
  counts?: Record<string, number>;
  completedAt?: Date;
}

const DeletionRequestSchema = new Schema<IDeletionRequest>(
  {
    provider: { type: String, required: true, index: true },
    externalUserId: { type: String, required: true, index: true },
    status: { type: String, enum: ['pending', 'completed', 'no_match'], default: 'pending' },
    detail: { type: String },
    counts: { type: Schema.Types.Mixed },
    completedAt: { type: Date },
  },
  { timestamps: true },
);

DeletionRequestSchema.index({ provider: 1, externalUserId: 1 });

export const DeletionRequest: Model<IDeletionRequest> =
  (models.DeletionRequest as Model<IDeletionRequest>) ||
  model<IDeletionRequest>('DeletionRequest', DeletionRequestSchema);


