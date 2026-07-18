import { FastifyInstance } from 'fastify';
import {
  approveBusinessDouble,
  confirmShipmentWizardDraft,
  createLabelAuditRun,
  createShipmentWizardDraft,
  generateBillingStatementPdf,
  generateInvoicePdf,
  getBillingInvoices,
  getBillingProfit,
  getBusinessDouble,
  getCommandCenter,
  getCopilotContext,
  getHeatmap,
  getInventoryPlan,
  getLabelAudit,
  getLabelAuditRun,
  getLabelAuditRuns,
  getLedger,
  getOmsAsn,
  getOmsAsns,
  getOmsCustomers,
  getOmsOrder,
  getOmsOrders,
  getOmsSkuDetail,
  getOmsSkus,
  getOmsSupplierActivity,
  getOmsSuppliers,
  getWarehouseDetail,
  getWarehouseOverview,
  generateShipmentPalletLabelsPdf,
  retryShipmentVendorEmail,
  updateOmsSkuEnrichment,
} from '../services/oms-production.service';
import { getKeepaSnapshot, peekKeepaSnapshot } from '../services/keepa';

function requireUser(req: any, reply: any): string | null {
  const userId = req.user?.userId;
  if (!userId) {
    reply.code(401).send({ error: 'Unauthorized' });
    return null;
  }
  return String(userId);
}

export async function omsProductionRoutes(fastify: FastifyInstance) {
  const marketplaceFilter = (query: any) => ({
    channel: typeof query?.channel === 'string' ? query.channel.trim() : undefined,
    channelAccountId: typeof query?.channelAccountId === 'string' ? query.channelAccountId.trim() : undefined,
  });

  fastify.get('/oms/command-center', async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const range = (req.query?.range === 'today' || req.query?.range === '7d' || req.query?.range === '30d') ? req.query.range : '7d';
    return getCommandCenter(userId, range);
  });

  fastify.get('/oms/business-double', async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    return getBusinessDouble(userId);
  });

  fastify.post('/oms/business-double/:planId/approve', async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const planId = String(req.params?.planId || 'generated');
    return approveBusinessDouble(userId, planId, req.user?.email || userId, req.log);
  });

  fastify.get('/oms/inventory-plan', async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    return getInventoryPlan(userId, String(req.query?.horizon || '6m'), marketplaceFilter(req.query));
  });

  fastify.get('/oms/skus', async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    return getOmsSkus(userId, marketplaceFilter(req.query));
  });

  fastify.get('/oms/skus/:skuId', async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const detail = await getOmsSkuDetail(userId, String(req.params?.skuId || ''));
    if (!detail) return reply.code(404).send({ error: 'SKU not found' });
    return detail;
  });

  fastify.patch('/oms/skus/:skuId/enrichment', async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const detail = await updateOmsSkuEnrichment(userId, String(req.params?.skuId || ''), req.body || {});
    if (!detail) return reply.code(404).send({ error: 'SKU not found' });
    return detail;
  });

  fastify.get('/oms/orders', async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    return getOmsOrders(userId, marketplaceFilter(req.query));
  });

  fastify.get('/oms/orders/:orderId', async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const order = await getOmsOrder(userId, String(req.params?.orderId || ''));
    if (!order) return reply.code(404).send({ error: 'Order not found' });
    return { order };
  });

  fastify.get('/oms/asns', async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    return getOmsAsns(userId);
  });

  fastify.get('/oms/asns/:asnId', async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const asn = await getOmsAsn(userId, String(req.params?.asnId || ''));
    if (!asn) return reply.code(404).send({ error: 'ASN not found' });
    return { asn };
  });

  fastify.get('/oms/customers', async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    return getOmsCustomers(userId);
  });

  fastify.get('/oms/suppliers', async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    return getOmsSuppliers(userId);
  });

  fastify.get('/oms/suppliers/:supplierId/activity', async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const detail = await getOmsSupplierActivity(userId, String(req.params?.supplierId || ''));
    if (!detail) return reply.code(404).send({ error: 'Supplier not found' });
    return detail;
  });

  fastify.post('/oms/shipment-wizard/drafts', async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    return createShipmentWizardDraft(userId, req.body || {});
  });

  fastify.post('/oms/shipment-wizard/drafts/:draftId/confirm', async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    return confirmShipmentWizardDraft(userId, String(req.params?.draftId || ''), req.body || {}, req.log);
  });

  fastify.get('/oms/shipment-wizard/drafts/:draftId/pallet-labels.pdf', async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const pdf = await generateShipmentPalletLabelsPdf(userId, String(req.params?.draftId || ''));
    if (!pdf) return reply.code(404).send({ error: 'Pallet labels not found' });
    reply
      .header('Content-Type', 'application/pdf')
      .header('Content-Disposition', `attachment; filename="${pdf.filename}"`);
    return reply.send(pdf.buffer);
  });

  fastify.post('/oms/shipment-wizard/drafts/:draftId/vendor-email/retry', async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    return retryShipmentVendorEmail(userId, String(req.params?.draftId || ''), req.log);
  });

  fastify.get('/oms/heatmap', async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    return getHeatmap(userId);
  });

  fastify.get('/oms/warehouses/overview', async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    return getWarehouseOverview(userId);
  });

  fastify.get('/oms/warehouses/:warehouseCode/detail', async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const detail = await getWarehouseDetail(userId, String(req.params?.warehouseCode || ''));
    if (!detail) return reply.code(404).send({ error: 'Warehouse not found' });
    return detail;
  });

  fastify.get('/oms/label-audit', async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    return getLabelAudit(userId);
  });

  fastify.post('/oms/label-audit/runs', async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    try {
      return await createLabelAuditRun(userId, req.body || {});
    } catch (err: any) {
      return reply.code(err?.statusCode || 500).send({ error: err?.message || 'Label audit run failed', details: err?.details || undefined });
    }
  });

  fastify.get('/oms/label-audit/runs', async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    return getLabelAuditRuns(userId);
  });

  fastify.get('/oms/label-audit/runs/:id', async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const detail = await getLabelAuditRun(userId, String(req.params?.id || ''));
    if (!detail) return reply.code(404).send({ error: 'Label audit run not found' });
    return detail;
  });

  const BILLING_RANGES = new Set(['today', '7d', '30d', '90d', 'mtd']);
  const billingRangeParams = (query: any) => {
    const range = BILLING_RANGES.has(query?.range) ? query.range : '30d';
    const from = typeof query?.from === 'string' && query.from ? query.from : undefined;
    const to = typeof query?.to === 'string' && query.to ? query.to : undefined;
    return { range, from, to };
  };

  fastify.get('/oms/billing-profit', async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    return getBillingProfit(userId, billingRangeParams(req.query));
  });

  fastify.get('/oms/billing/invoices', async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const q = req.query || {};
    return getBillingInvoices(userId, {
      ...billingRangeParams(q),
      category: typeof q.category === 'string' ? q.category.trim() : undefined,
      warehouseCode: typeof q.warehouseCode === 'string' ? q.warehouseCode.trim() : undefined,
      status: typeof q.status === 'string' ? q.status.trim() : undefined,
      search: typeof q.search === 'string' ? q.search.trim() : undefined,
      invoiceNumber: typeof q.invoiceNumber === 'string' ? q.invoiceNumber.trim() : undefined,
      limit: q.limit ? Math.min(200, Math.max(1, Number(q.limit) || 50)) : 50,
      offset: q.offset ? Math.max(0, Number(q.offset) || 0) : 0,
    });
  });

  fastify.get('/oms/billing/statement.pdf', async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const q = req.query || {};
    const pdf = await generateBillingStatementPdf(userId, {
      ...billingRangeParams(q),
      category: typeof q.category === 'string' ? q.category.trim() : undefined,
      warehouseCode: typeof q.warehouseCode === 'string' ? q.warehouseCode.trim() : undefined,
      status: typeof q.status === 'string' ? q.status.trim() : undefined,
      search: typeof q.search === 'string' ? q.search.trim() : undefined,
    });
    reply
      .header('Content-Type', 'application/pdf')
      .header('Content-Disposition', `attachment; filename="${pdf.filename}"`);
    return reply.send(pdf.buffer);
  });

  fastify.get('/oms/billing/invoices/:invoiceNumber/export.pdf', async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const pdf = await generateInvoicePdf(userId, String(req.params?.invoiceNumber || ''));
    if (!pdf) return reply.code(404).send({ error: 'Invoice not found' });
    reply
      .header('Content-Type', 'application/pdf')
      .header('Content-Disposition', `attachment; filename="${pdf.filename}"`);
    return reply.send(pdf.buffer);
  });

  fastify.get('/oms/ledger', async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    return getLedger(userId);
  });

  fastify.get('/oms/copilot/context', async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    return getCopilotContext(userId, String(req.query?.screen || 'command-center'));
  });
  fastify.get('/oms/keepa/:asin', async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const asin = String(req.params?.asin || '').trim().toUpperCase();
    if (!asin) return reply.code(400).send({ error: 'asin required' });
    const peek = await peekKeepaSnapshot(asin);
    return { asin, snapshot: peek };
  });

  fastify.post('/oms/keepa/:asin/refresh', async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    const asin = String(req.params?.asin || '').trim().toUpperCase();
    if (!asin) return reply.code(400).send({ error: 'asin required' });
    try {
      const snap = await getKeepaSnapshot(asin, { force: true });
      return { asin, snapshot: snap };
    } catch (err: any) {
      return reply.code(502).send({ error: err?.message || 'Keepa refresh failed' });
    }
  });

}
