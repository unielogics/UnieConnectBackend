/**
 * Warehouse code alignment: X-Warehouse-ID and Facility.code must use the same value.
 * OmsIntermediaryWarehouse.warehouseCode should equal Facility.code for the WMS User (wmsIntermediaryId).
 * When creating OmsIntermediaryWarehouse links, use Facility.code as warehouseCode.
 */

import { Facility } from '../models/facility';
import { Types } from 'mongoose';

/** Valid warehouse code format (matches X-Warehouse-ID validation) */
export const WAREHOUSE_CODE_REGEX = /^[a-zA-Z0-9_-]{1,64}$/;

/**
 * Resolve (userId, warehouseCode) to Facility.
 * Tries exact match first, then case-insensitive and trimmed.
 */
export async function getFacilityByWarehouseCode(
  userId: string | Types.ObjectId,
  warehouseCode: string,
) {
  const wc = warehouseCode?.trim?.() ?? '';
  if (!wc) return null;
  const userIdObj = new Types.ObjectId(userId);

  let fac = await Facility.findOne({
    userId: userIdObj,
    code: wc,
    isActive: true,
  })
    .lean()
    .exec();

  if (!fac) {
    fac = await Facility.findOne({
      userId: userIdObj,
      code: new RegExp(`^\\s*${wc.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'i'),
      isActive: true,
    })
      .lean()
      .exec();
  }

  return fac;
}
