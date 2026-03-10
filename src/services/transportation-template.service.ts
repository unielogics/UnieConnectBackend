import { Types } from 'mongoose';
import { TransportationTemplate } from '../models/transportation-template';

export interface CreateTransportationTemplateInput {
  userId: string;
  name: string;
  supplierId?: string;
  unitsPerBox: number;
  weightPerBox: number;
  weightPerUnit?: number;
  dimensions?: { length?: number; width?: number; height?: number };
}

export interface UpdateTransportationTemplateInput {
  userId: string;
  id: string;
  name?: string;
  supplierId?: string;
  unitsPerBox?: number;
  weightPerBox?: number;
  weightPerUnit?: number;
  dimensions?: { length?: number; width?: number; height?: number };
}

export async function listTransportationTemplates(params: {
  userId: string;
  supplierId?: string;
}): Promise<any[]> {
  const query: Record<string, unknown> = { userId: new Types.ObjectId(params.userId) };
  if (params.supplierId) {
    query.supplierId = new Types.ObjectId(params.supplierId);
  }
  const docs = await TransportationTemplate.find(query)
    .sort({ updatedAt: -1, name: 1 })
    .lean()
    .exec();
  return docs.map((d: any) => ({
    id: String(d._id),
    name: d.name,
    supplierId: d.supplierId ? String(d.supplierId) : undefined,
    unitsPerBox: d.unitsPerBox,
    weightPerBox: d.weightPerBox,
    weightPerUnit: d.weightPerUnit,
    dimensions: d.dimensions,
  }));
}

export async function getTransportationTemplate(params: {
  userId: string;
  id: string;
}): Promise<any | null> {
  const doc = await TransportationTemplate.findOne({
    _id: params.id,
    userId: params.userId,
  })
    .lean()
    .exec();
  if (!doc) return null;
  const d = doc as any;
  return {
    id: String(d._id),
    name: d.name,
    supplierId: d.supplierId ? String(d.supplierId) : undefined,
    unitsPerBox: d.unitsPerBox,
    weightPerBox: d.weightPerBox,
    weightPerUnit: d.weightPerUnit,
    dimensions: d.dimensions,
  };
}

export async function createTransportationTemplate(input: CreateTransportationTemplateInput): Promise<any> {
  const doc = await TransportationTemplate.create({
    name: input.name,
    userId: new Types.ObjectId(input.userId),
    supplierId: input.supplierId ? new Types.ObjectId(input.supplierId) : undefined,
    unitsPerBox: input.unitsPerBox,
    weightPerBox: input.weightPerBox,
    weightPerUnit: input.weightPerUnit,
    dimensions: input.dimensions,
  });
  return {
    id: String(doc._id),
    name: doc.name,
    supplierId: doc.supplierId ? String(doc.supplierId) : undefined,
    unitsPerBox: doc.unitsPerBox,
    weightPerBox: doc.weightPerBox,
    weightPerUnit: doc.weightPerUnit,
    dimensions: doc.dimensions,
  };
}

export async function updateTransportationTemplate(input: UpdateTransportationTemplateInput): Promise<any | null> {
  const update: Record<string, unknown> = {};
  if (input.name !== undefined) update.name = input.name;
  if (input.supplierId !== undefined) update.supplierId = input.supplierId ? new Types.ObjectId(input.supplierId) : null;
  if (input.unitsPerBox !== undefined) update.unitsPerBox = input.unitsPerBox;
  if (input.weightPerBox !== undefined) update.weightPerBox = input.weightPerBox;
  if (input.weightPerUnit !== undefined) update.weightPerUnit = input.weightPerUnit;
  if (input.dimensions !== undefined) update.dimensions = input.dimensions;

  const doc = await TransportationTemplate.findOneAndUpdate(
    { _id: input.id, userId: input.userId },
    { $set: update },
    { new: true }
  )
    .lean()
    .exec();
  if (!doc) return null;
  const d = doc as any;
  return {
    id: String(d._id),
    name: d.name,
    supplierId: d.supplierId ? String(d.supplierId) : undefined,
    unitsPerBox: d.unitsPerBox,
    weightPerBox: d.weightPerBox,
    weightPerUnit: d.weightPerUnit,
    dimensions: d.dimensions,
  };
}

export async function deleteTransportationTemplate(params: {
  userId: string;
  id: string;
}): Promise<boolean> {
  const result = await TransportationTemplate.deleteOne({
    _id: params.id,
    userId: params.userId,
  }).exec();
  return (result.deletedCount ?? 0) > 0;
}
