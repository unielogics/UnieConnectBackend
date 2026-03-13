import { Schema, model, models, Model, Document, Types } from 'mongoose';

export interface INote extends Document {
  userId: Types.ObjectId;
  entityType: string;
  entityId: string;
  body: string;
  createdByName?: string;
  createdAt?: Date;
}

const NoteSchema = new Schema<INote>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    entityType: { type: String, required: true, index: true },
    entityId: { type: String, required: true, index: true },
    body: { type: String, required: true, trim: true },
    createdByName: { type: String, trim: true },
  },
  { timestamps: true }
);

NoteSchema.index({ userId: 1, entityType: 1, entityId: 1 });

export const Note: Model<INote> =
  (models.Note as Model<INote>) || model<INote>('Note', NoteSchema);
