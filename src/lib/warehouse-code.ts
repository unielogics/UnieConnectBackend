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
 * warehouseCode must equal Facility.code for the given User.
 */
export async function getFacilityByWarehouseCode(
  userId: string | Types.ObjectId,
  warehouseCode: string,
) {
  return Facility.findOne({
    userId: new Types.ObjectId(userId),
    code: warehouseCode,
    isActive: true,
  })
    .lean()
    .exec();
}
