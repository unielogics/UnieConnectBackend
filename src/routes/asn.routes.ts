import { FastifyInstance } from 'fastify';
import fetch from 'node-fetch';
import { ASN } from '../models/asn';
import { Facility } from '../models/facility';
import { config } from '../config/env';

/**
 * ASN routes. GET /asn/:id/label - proxies to WMS when wmsAsnId exists.
 */
export async function asnRoutes(fastify: FastifyInstance) {
  fastify.get<{ Params: { id: string } }>('/asn/:id/label', async (req: any, reply) => {
    const userId = req.user?.userId;
    if (!userId) return reply.code(401).send({ error: 'Unauthorized' });

    const asn = await ASN.findOne({ _id: req.params.id, userId }).lean().exec();
    if (!asn) return reply.code(404).send({ error: 'ASN not found' });

    const wmsAsnId = (asn as any).wmsAsnId;
    if (!wmsAsnId || !config.wmsApiUrl || !config.internalApiKey) {
      return reply.code(404).send({
        error: 'ASN label not available. WMS integration required.',
      });
    }

    const facility = await Facility.findById((asn as any).facilityId).select('code').lean().exec();
    const warehouseCode = (facility as any)?.code;
    if (!warehouseCode) {
      return reply.code(404).send({ error: 'Warehouse not found for this ASN' });
    }

    const url = `${config.wmsApiUrl}/api/v1/internal/oms/asn/${encodeURIComponent(wmsAsnId)}/label?warehouseCode=${encodeURIComponent(warehouseCode)}`;
    const res = await fetch(url, {
      method: 'GET',
      headers: { 'X-Internal-Api-Key': config.internalApiKey },
    });

    if (!res.ok) {
      return reply.code(res.status).send({
        error: res.status === 404 ? 'ASN label PDF not yet generated' : 'Failed to fetch ASN label',
      });
    }

    const pdfBuffer = Buffer.from(await res.arrayBuffer());
    return reply
      .header('Content-Type', 'application/pdf')
      .header('Content-Disposition', `inline; filename="ASN-${(asn as any).poNo || 'label'}.pdf"`)
      .send(pdfBuffer);
  });

  fastify.get<{ Params: { id: string; wmsItemId: string } }>(
    '/asn/:id/items/:wmsItemId/barcode-pdf',
    async (req: any, reply) => {
      const userId = req.user?.userId;
      if (!userId) return reply.code(401).send({ error: 'Unauthorized' });

      const asn = await ASN.findOne({ _id: req.params.id, userId }).lean().exec();
      if (!asn) return reply.code(404).send({ error: 'ASN not found' });

      const facility = await Facility.findById((asn as any).facilityId).select('code').lean().exec();
      const warehouseCode = (facility as any)?.code;
      if (!warehouseCode || !config.wmsApiUrl || !config.internalApiKey) {
        return reply.code(404).send({ error: 'Item barcode not available' });
      }

      const url = `${config.wmsApiUrl}/api/v1/internal/oms/items/${encodeURIComponent(req.params.wmsItemId)}/barcode-pdf?warehouseCode=${encodeURIComponent(warehouseCode)}`;
      const res = await fetch(url, {
        headers: { 'X-Internal-Api-Key': config.internalApiKey },
      });

      if (!res.ok) {
        return reply.code(res.status).send({ error: 'Failed to fetch item barcode' });
      }

      const pdfBuffer = Buffer.from(await res.arrayBuffer());
      return reply
        .header('Content-Type', 'application/pdf')
        .header('Content-Disposition', `inline; filename="item-${req.params.wmsItemId}.pdf"`)
        .send(pdfBuffer);
    }
  );
}
