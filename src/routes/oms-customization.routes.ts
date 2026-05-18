import { createHash, randomBytes } from 'crypto';
import { FastifyInstance } from 'fastify';
import { pgQuery } from '../db/postgres';

type AnyRow = Record<string, any>;

const API_SCOPES = ['oms:read', 'oms:write', 'apps:manage', 'workflows:run', 'events:write'];
const DEFAULT_API_SCOPES = ['oms:read', 'workflows:run', 'events:write'];
const RISKY_ACTIONS = [
  'wms_task_update',
  'wms_update',
  'tms_dispatch',
  'dispatch_driver',
  'carrier_purchase',
  'label_purchase',
  'billing_refund_submission',
  'inventory_placement_execution',
];

const trim = (value: unknown) => (value == null ? '' : String(value).trim());
const iso = (value: unknown) => (value ? new Date(value as any).toISOString() : undefined);
const json = (value: unknown, fallback: any) => (value == null ? fallback : value);

async function one<T extends AnyRow = AnyRow>(sql: string, values: unknown[] = []): Promise<T | null> {
  const res = await pgQuery<T>(sql, values);
  return res?.rows[0] || null;
}

async function rows<T extends AnyRow = AnyRow>(sql: string, values: unknown[] = []): Promise<T[]> {
  const res = await pgQuery<T>(sql, values);
  return res?.rows || [];
}

function idempotencyKey(req: any) {
  return trim(req.headers?.['idempotency-key'] || req.headers?.['x-idempotency-key']);
}

function sanitizeScopes(input: unknown, fallback = DEFAULT_API_SCOPES) {
  if (!Array.isArray(input)) return fallback;
  const scopes = input.map((s) => trim(s)).filter((s) => API_SCOPES.includes(s));
  return scopes.length ? Array.from(new Set(scopes)) : fallback;
}

function apiKeyFromRequest(req: any) {
  const auth = trim(req.headers?.authorization);
  if (auth.toLowerCase().startsWith('bearer uc_')) return auth.slice(7).trim();
  return trim(req.headers?.['x-oms-api-key'] || req.headers?.['x-api-key']);
}

async function resolveIdentity(req: any, reply: any, requiredScope?: string) {
  const jwtUserId = req.user?.userId;
  if (jwtUserId) return { userId: String(jwtUserId), authMode: 'jwt', scopes: ['*'] };

  const rawKey = apiKeyFromRequest(req);
  if (!rawKey) {
    reply.code(401).send({ error: 'Unauthorized' });
    return null;
  }

  const keyHash = createHash('sha256').update(rawKey).digest('hex');
  const key = await one(
    `SELECT id, user_id, scopes
     FROM api_keys
     WHERE key_hash = $1 AND status = 'active'
     LIMIT 1`,
    [keyHash],
  );
  if (!key) {
    reply.code(401).send({ error: 'Invalid API key' });
    return null;
  }

  const scopes = Array.isArray(key.scopes) ? key.scopes : [];
  if (requiredScope && !scopes.includes(requiredScope) && !scopes.includes('*')) {
    reply.code(403).send({ error: 'Missing API key scope', requiredScope });
    return null;
  }

  await pgQuery('UPDATE api_keys SET last_used_at = now() WHERE id = $1', [key.id]).catch(() => null);
  req.user = { userId: key.user_id, role: 'api_key', apiKeyId: key.id };
  return { userId: String(key.user_id), authMode: 'api_key', scopes };
}

function requireJwtUser(req: any, reply: any): string | null {
  const userId = req.user?.userId;
  if (!userId) {
    reply.code(401).send({ error: 'Unauthorized' });
    return null;
  }
  return String(userId);
}

async function writeLedger(
  userId: string,
  params: { entityType: string; entityId?: string | null; eventType: string; summary: string; payload?: any; sourceSystem?: string; confidence?: number },
) {
  await pgQuery(
    `INSERT INTO oms_execution_ledger
      (user_id, entity_type, entity_id, event_type, source_system, summary, payload, confidence)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)`,
    [
      userId,
      params.entityType,
      params.entityId || null,
      params.eventType,
      params.sourceSystem || 'oms',
      params.summary,
      JSON.stringify(params.payload || {}),
      params.confidence ?? null,
    ],
  ).catch(() => null);
}

function mapApp(row: AnyRow) {
  return {
    id: row.id,
    templateFeatureId: row.template_feature_id,
    name: row.name,
    description: row.description,
    icon: row.icon,
    status: row.status,
    visibility: row.visibility,
    config: json(row.config, {}),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function mapEmployee(row: AnyRow) {
  return {
    id: row.id,
    appId: row.app_id,
    name: row.name,
    role: row.role,
    instructions: row.instructions,
    autonomyLevel: row.autonomy_level,
    allowedDataSources: row.allowed_data_sources || [],
    allowedActions: row.allowed_actions || [],
    status: row.status,
    config: json(row.config, {}),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function mapWorkflow(row: AnyRow) {
  return {
    id: row.id,
    appId: row.app_id,
    aiEmployeeId: row.ai_employee_id,
    name: row.name,
    description: row.description,
    triggerType: row.trigger_type,
    triggerConfig: json(row.trigger_config, {}),
    definition: json(row.definition, {}),
    guardrailPolicy: json(row.guardrail_policy, {}),
    status: row.status,
    version: Number(row.version || 1),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function mapRun(row: AnyRow) {
  return {
    id: row.id,
    workflowId: row.workflow_id,
    appId: row.app_id,
    aiEmployeeId: row.ai_employee_id,
    workflowName: row.workflow_name,
    status: row.status,
    triggerType: row.trigger_type,
    input: json(row.input, {}),
    output: json(row.output, {}),
    error: row.error,
    confidence: row.confidence == null ? null : Number(row.confidence),
    approvalState: row.approval_state,
    approvalRequestedAt: iso(row.approval_requested_at),
    approvedAt: iso(row.approved_at),
    startedAt: iso(row.started_at),
    completedAt: iso(row.completed_at),
    idempotencyKey: row.idempotency_key,
    createdAt: iso(row.created_at),
  };
}

function mapApiKey(row: AnyRow) {
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    scopes: row.scopes || [],
    status: row.status,
    lastUsedAt: iso(row.last_used_at),
    revokedAt: iso(row.revoked_at),
    createdAt: iso(row.created_at),
  };
}

function definitionRequiresApproval(workflow: AnyRow, input: any) {
  const policy = json(workflow.guardrail_policy, {});
  if (policy?.autonomy === 'manual') return true;
  const required = Array.isArray(policy?.approvalRequiredFor) ? policy.approvalRequiredFor : RISKY_ACTIONS;
  const haystack = JSON.stringify({
    definition: json(workflow.definition, {}),
    input: input || {},
  }).toLowerCase();
  return required.some((action: unknown) => haystack.includes(trim(action).toLowerCase()));
}

async function createWorkflowRun(params: {
  userId: string;
  workflow: AnyRow;
  triggerType: string;
  input: any;
  idempotencyKey?: string | null;
}) {
  const key = params.idempotencyKey || null;
  if (key) {
    const existing = await one(
      `SELECT r.*, w.name AS workflow_name
       FROM oms_workflow_runs r
       LEFT JOIN oms_workflows w ON w.id = r.workflow_id
       WHERE r.user_id = $1 AND r.idempotency_key = $2
       LIMIT 1`,
      [params.userId, key],
    );
    if (existing) return { run: existing, duplicate: true };
  }

  const requiresApproval = definitionRequiresApproval(params.workflow, params.input);
  const nowOutput = requiresApproval
    ? {
        message: 'Workflow paused for approval before executing guarded WMS/TMS or financial actions.',
        approvalRequiredFor: RISKY_ACTIONS,
      }
    : {
        message: 'Workflow completed in guarded OMS mode.',
        actions: json(params.workflow.definition, {}).steps || [],
      };

  const run = await one(
    `INSERT INTO oms_workflow_runs
      (user_id, workflow_id, app_id, ai_employee_id, status, trigger_type, input, output, confidence,
       approval_state, approval_requested_at, started_at, completed_at, idempotency_key)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10, $11, now(), $12, $13)
     RETURNING *`,
    [
      params.userId,
      params.workflow.id,
      params.workflow.app_id || null,
      params.workflow.ai_employee_id || null,
      requiresApproval ? 'pending_approval' : 'completed',
      params.triggerType,
      JSON.stringify(params.input || {}),
      JSON.stringify(nowOutput),
      requiresApproval ? 0.82 : 0.91,
      requiresApproval ? 'required' : 'not_required',
      requiresApproval ? new Date() : null,
      requiresApproval ? null : new Date(),
      key,
    ],
  );

  await writeLedger(params.userId, {
    entityType: 'oms_workflow',
    entityId: params.workflow.id,
    eventType: requiresApproval ? 'workflow_pending_approval' : 'workflow_completed',
    summary: requiresApproval
      ? `Workflow ${params.workflow.name} paused for approval.`
      : `Workflow ${params.workflow.name} completed.`,
    payload: { runId: run?.id, triggerType: params.triggerType, idempotencyKey: key },
    confidence: requiresApproval ? 0.82 : 0.91,
  });

  return { run, duplicate: false };
}

export async function omsCustomizationRoutes(app: FastifyInstance) {
  app.get('/oms/apps', async (req: any, reply) => {
    const identity = await resolveIdentity(req, reply, 'oms:read');
    if (!identity) return;
    const data = await rows('SELECT * FROM oms_custom_apps WHERE user_id = $1 ORDER BY updated_at DESC', [identity.userId]);
    return { apps: data.map(mapApp) };
  });

  app.post('/oms/apps', async (req: any, reply) => {
    const identity = await resolveIdentity(req, reply, 'apps:manage');
    if (!identity) return;
    const body = req.body || {};
    const name = trim(body.name);
    if (!name) return reply.code(400).send({ error: 'name is required' });
    const appRow = await one(
      `INSERT INTO oms_custom_apps
        (user_id, template_feature_id, name, description, icon, status, visibility, config, created_by)
       VALUES ($1, $2, $3, $4, COALESCE($5, 'grid'), COALESCE($6, 'draft'), 'private', $7::jsonb, $8)
       RETURNING *`,
      [
        identity.userId,
        body.templateFeatureId || null,
        name,
        trim(body.description) || null,
        trim(body.icon) || null,
        ['draft', 'active', 'paused'].includes(body.status) ? body.status : 'draft',
        JSON.stringify(body.config || {}),
        identity.authMode === 'jwt' ? identity.userId : null,
      ],
    );
    await writeLedger(identity.userId, {
      entityType: 'oms_custom_app',
      entityId: appRow?.id,
      eventType: 'created',
      summary: `Custom OMS app ${name} created.`,
      payload: { templateFeatureId: body.templateFeatureId || null },
    });
    return { app: mapApp(appRow || {}) };
  });

  app.post('/oms/apps/:id/install-template', async (req: any, reply) => {
    const identity = await resolveIdentity(req, reply, 'apps:manage');
    if (!identity) return;
    const feature = await one('SELECT * FROM features WHERE id = $1', [req.params.id]);
    if (!feature) return reply.code(404).send({ error: 'Template not found' });
    const payload = json(feature.payload, {});
    const appRow = await one(
      `INSERT INTO oms_custom_apps
        (user_id, template_feature_id, name, description, icon, status, visibility, config, created_by)
       VALUES ($1, $2, $3, $4, $5, 'active', 'private', $6::jsonb, $7)
       RETURNING *`,
      [
        identity.userId,
        feature.id,
        trim(req.body?.name) || feature.name,
        feature.description,
        payload?.metadata?.navIcon || 'grid',
        JSON.stringify({ sourceTemplate: feature.id, ...(req.body?.config || {}) }),
        identity.authMode === 'jwt' ? identity.userId : null,
      ],
    );
    await writeLedger(identity.userId, {
      entityType: 'oms_custom_app',
      entityId: appRow?.id,
      eventType: 'template_installed',
      summary: `Marketplace template ${feature.name} installed as a private app.`,
      payload: { templateFeatureId: feature.id },
    });
    return { app: mapApp(appRow || {}) };
  });

  app.get('/oms/apps/:id', async (req: any, reply) => {
    const identity = await resolveIdentity(req, reply, 'oms:read');
    if (!identity) return;
    const appRow = await one('SELECT * FROM oms_custom_apps WHERE id = $1 AND user_id = $2', [req.params.id, identity.userId]);
    if (!appRow) return reply.code(404).send({ error: 'Not found' });
    return { app: mapApp(appRow) };
  });

  app.patch('/oms/apps/:id', async (req: any, reply) => {
    const identity = await resolveIdentity(req, reply, 'apps:manage');
    if (!identity) return;
    const body = req.body || {};
    const appRow = await one(
      `UPDATE oms_custom_apps
       SET name = COALESCE($3, name),
           description = COALESCE($4, description),
           icon = COALESCE($5, icon),
           status = COALESCE($6, status),
           config = config || COALESCE($7::jsonb, '{}'::jsonb),
           updated_at = now()
       WHERE id = $1 AND user_id = $2
       RETURNING *`,
      [
        req.params.id,
        identity.userId,
        body.name === undefined ? null : trim(body.name),
        body.description === undefined ? null : trim(body.description),
        body.icon === undefined ? null : trim(body.icon),
        ['draft', 'active', 'paused', 'archived'].includes(body.status) ? body.status : null,
        body.config === undefined ? null : JSON.stringify(body.config || {}),
      ],
    );
    if (!appRow) return reply.code(404).send({ error: 'Not found' });
    await writeLedger(identity.userId, {
      entityType: 'oms_custom_app',
      entityId: appRow.id,
      eventType: 'updated',
      summary: `Custom OMS app ${appRow.name} updated.`,
    });
    return { app: mapApp(appRow) };
  });

  app.post('/oms/apps/:id/archive', async (req: any, reply) => {
    const identity = await resolveIdentity(req, reply, 'apps:manage');
    if (!identity) return;
    const appRow = await one(
      `UPDATE oms_custom_apps SET status = 'archived', updated_at = now()
       WHERE id = $1 AND user_id = $2 RETURNING *`,
      [req.params.id, identity.userId],
    );
    if (!appRow) return reply.code(404).send({ error: 'Not found' });
    await writeLedger(identity.userId, {
      entityType: 'oms_custom_app',
      entityId: appRow.id,
      eventType: 'archived',
      summary: `Custom OMS app ${appRow.name} archived.`,
    });
    return { success: true, app: mapApp(appRow) };
  });

  app.get('/oms/ai-employees', async (req: any, reply) => {
    const identity = await resolveIdentity(req, reply, 'oms:read');
    if (!identity) return;
    const data = await rows('SELECT * FROM oms_ai_employees WHERE user_id = $1 ORDER BY updated_at DESC', [identity.userId]);
    return { employees: data.map(mapEmployee) };
  });

  app.post('/oms/ai-employees', async (req: any, reply) => {
    const identity = await resolveIdentity(req, reply, 'apps:manage');
    if (!identity) return;
    const body = req.body || {};
    const name = trim(body.name);
    if (!name) return reply.code(400).send({ error: 'name is required' });
    const employee = await one(
      `INSERT INTO oms_ai_employees
        (user_id, app_id, name, role, instructions, autonomy_level, allowed_data_sources, allowed_actions, status, config, created_by)
       VALUES ($1, $2, $3, COALESCE($4, 'operations analyst'), COALESCE($5, ''), 'guarded', $6, $7, COALESCE($8, 'active'), $9::jsonb, $10)
       RETURNING *`,
      [
        identity.userId,
        body.appId || null,
        name,
        trim(body.role) || null,
        trim(body.instructions) || null,
        Array.isArray(body.allowedDataSources) && body.allowedDataSources.length ? body.allowedDataSources.map(trim) : ['oms', 'wms', 'cortex'],
        Array.isArray(body.allowedActions) && body.allowedActions.length
          ? body.allowedActions.map(trim)
          : ['recommend', 'create_ticket', 'write_ledger', 'draft_shipment_plan'],
        ['active', 'paused'].includes(body.status) ? body.status : 'active',
        JSON.stringify(body.config || {}),
        identity.authMode === 'jwt' ? identity.userId : null,
      ],
    );
    await writeLedger(identity.userId, {
      entityType: 'oms_ai_employee',
      entityId: employee?.id,
      eventType: 'created',
      summary: `AI employee ${name} created with guarded autonomy.`,
      payload: { appId: body.appId || null },
    });
    return { employee: mapEmployee(employee || {}) };
  });

  app.get('/oms/workflows', async (req: any, reply) => {
    const identity = await resolveIdentity(req, reply, 'oms:read');
    if (!identity) return;
    const data = await rows('SELECT * FROM oms_workflows WHERE user_id = $1 ORDER BY updated_at DESC', [identity.userId]);
    return { workflows: data.map(mapWorkflow) };
  });

  app.post('/oms/workflows', async (req: any, reply) => {
    const identity = await resolveIdentity(req, reply, 'apps:manage');
    if (!identity) return;
    const body = req.body || {};
    const name = trim(body.name);
    if (!name) return reply.code(400).send({ error: 'name is required' });
    const triggerType = trim(body.triggerType || 'manual') || 'manual';
    const workflow = await one(
      `INSERT INTO oms_workflows
        (user_id, app_id, ai_employee_id, name, description, trigger_type, trigger_config, definition, guardrail_policy, status, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb, COALESCE($10, 'draft'), $11)
       RETURNING *`,
      [
        identity.userId,
        body.appId || null,
        body.aiEmployeeId || null,
        name,
        trim(body.description) || null,
        triggerType,
        JSON.stringify(body.triggerConfig || {}),
        JSON.stringify(body.definition || { steps: [] }),
        JSON.stringify({
          autonomy: 'guarded',
          approvalRequiredFor: RISKY_ACTIONS,
          ...(body.guardrailPolicy || {}),
        }),
        ['draft', 'active', 'paused'].includes(body.status) ? body.status : 'draft',
        identity.authMode === 'jwt' ? identity.userId : null,
      ],
    );
    await writeLedger(identity.userId, {
      entityType: 'oms_workflow',
      entityId: workflow?.id,
      eventType: 'created',
      summary: `Workflow ${name} created.`,
      payload: { triggerType },
    });
    return { workflow: mapWorkflow(workflow || {}) };
  });

  app.post('/oms/workflows/:id/run', async (req: any, reply) => {
    const bodyTrigger = trim(req.body?.triggerType);
    const scope = bodyTrigger === 'webhook' || bodyTrigger === 'inbound_api' ? 'workflows:run' : 'workflows:run';
    const identity = await resolveIdentity(req, reply, scope);
    if (!identity) return;
    const workflow = await one('SELECT * FROM oms_workflows WHERE id = $1 AND user_id = $2', [req.params.id, identity.userId]);
    if (!workflow) return reply.code(404).send({ error: 'Not found' });
    if (workflow.status !== 'active' && identity.authMode === 'api_key') {
      return reply.code(409).send({ error: 'Workflow is not active' });
    }
    const triggerType = bodyTrigger || workflow.trigger_type || 'manual';
    const key = idempotencyKey(req);
    if ((triggerType === 'webhook' || triggerType === 'inbound_api') && !key) {
      return reply.code(400).send({ error: 'Idempotency-Key header is required for webhook and inbound API workflow runs' });
    }
    const result = await createWorkflowRun({
      userId: identity.userId,
      workflow,
      triggerType,
      input: req.body?.input || req.body || {},
      idempotencyKey: key || null,
    });
    return { run: mapRun({ ...(result.run || {}), workflow_name: workflow.name }), duplicate: result.duplicate };
  });

  app.post('/oms/workflows/:id/approve', async (req: any, reply) => {
    const userId = requireJwtUser(req, reply);
    if (!userId) return;
    const workflow = await one('SELECT * FROM oms_workflows WHERE id = $1 AND user_id = $2', [req.params.id, userId]);
    if (!workflow) return reply.code(404).send({ error: 'Workflow not found' });
    const runId = trim(req.body?.runId);
    const pending = runId
      ? await one('SELECT * FROM oms_workflow_runs WHERE id = $1 AND workflow_id = $2 AND user_id = $3', [runId, workflow.id, userId])
      : await one(
          `SELECT * FROM oms_workflow_runs
           WHERE workflow_id = $1 AND user_id = $2 AND approval_state = 'required'
           ORDER BY created_at DESC LIMIT 1`,
          [workflow.id, userId],
        );
    if (!pending) return reply.code(404).send({ error: 'Pending run not found' });
    const approved = await one(
      `UPDATE oms_workflow_runs
       SET status = 'completed',
           approval_state = 'approved',
           approved_at = now(),
           approved_by = $3,
           completed_at = now(),
           output = output || $4::jsonb
       WHERE id = $1 AND user_id = $2
       RETURNING *`,
      [
        pending.id,
        userId,
        userId,
        JSON.stringify({ approvedBy: userId, approvedAt: new Date().toISOString(), approvalNote: trim(req.body?.note) || null }),
      ],
    );
    await writeLedger(userId, {
      entityType: 'oms_workflow_run',
      entityId: approved?.id,
      eventType: 'workflow_approved',
      summary: `Guarded workflow ${workflow.name} approved.`,
      payload: { workflowId: workflow.id, runId: approved?.id },
    });
    return { run: mapRun({ ...(approved || {}), workflow_name: workflow.name }) };
  });

  app.get('/oms/workflow-runs', async (req: any, reply) => {
    const identity = await resolveIdentity(req, reply, 'oms:read');
    if (!identity) return;
    const limit = Math.min(200, Math.max(1, Number(req.query?.limit || 100)));
    const data = await rows(
      `SELECT r.*, w.name AS workflow_name
       FROM oms_workflow_runs r
       LEFT JOIN oms_workflows w ON w.id = r.workflow_id
       WHERE r.user_id = $1
       ORDER BY r.created_at DESC
       LIMIT $2`,
      [identity.userId, limit],
    );
    return { runs: data.map(mapRun) };
  });

  app.post('/oms/events', async (req: any, reply) => {
    const identity = await resolveIdentity(req, reply, 'events:write');
    if (!identity) return;
    const key = idempotencyKey(req);
    if (!key) return reply.code(400).send({ error: 'Idempotency-Key header is required for inbound events' });
    const existing = await one('SELECT * FROM oms_workflow_events WHERE user_id = $1 AND idempotency_key = $2 LIMIT 1', [identity.userId, key]);
    if (existing) return { event: existing, runs: [], duplicate: true };

    const eventType = trim(req.body?.eventType);
    if (!eventType) return reply.code(400).send({ error: 'eventType is required' });
    const event = await one(
      `INSERT INTO oms_workflow_events (user_id, event_type, source_system, payload, idempotency_key)
       VALUES ($1, $2, $3, $4::jsonb, $5)
       RETURNING *`,
      [identity.userId, eventType, trim(req.body?.sourceSystem) || 'api', JSON.stringify(req.body?.payload || {}), key],
    );
    const workflows = await rows(
      `SELECT * FROM oms_workflows
       WHERE user_id = $1
         AND status = 'active'
         AND trigger_type IN ('oms_event', 'wms_event', 'webhook', 'inbound_api')
         AND (trigger_config->>'eventType' IS NULL OR trigger_config->>'eventType' = $2)`,
      [identity.userId, eventType],
    );
    const runs = [];
    for (const workflow of workflows) {
      const runResult = await createWorkflowRun({
        userId: identity.userId,
        workflow,
        triggerType: workflow.trigger_type,
        input: { eventType, payload: req.body?.payload || {} },
        idempotencyKey: `${key}:${workflow.id}`,
      });
      if (runResult.run) runs.push(mapRun({ ...runResult.run, workflow_name: workflow.name }));
    }
    await writeLedger(identity.userId, {
      entityType: 'oms_workflow_event',
      entityId: event?.id,
      eventType: 'api_event_received',
      sourceSystem: trim(req.body?.sourceSystem) || 'api',
      summary: `Inbound OMS event ${eventType} received.`,
      payload: { matchedWorkflows: workflows.length, idempotencyKey: key },
    });
    return { event, runs, duplicate: false };
  });

  app.get('/oms/api-keys', async (req: any, reply) => {
    const userId = requireJwtUser(req, reply);
    if (!userId) return;
    const data = await rows(
      `SELECT id, name, prefix, scopes, status, last_used_at, revoked_at, created_at
       FROM api_keys
       WHERE user_id = $1
       ORDER BY created_at DESC`,
      [userId],
    );
    return { apiKeys: data.map(mapApiKey), availableScopes: API_SCOPES };
  });

  app.post('/oms/api-keys', async (req: any, reply) => {
    const userId = requireJwtUser(req, reply);
    if (!userId) return;
    const raw = `uc_${randomBytes(24).toString('hex')}`;
    const keyHash = createHash('sha256').update(raw).digest('hex');
    const prefix = raw.slice(0, 10);
    const scopes = sanitizeScopes(req.body?.scopes);
    const row = await one(
      `INSERT INTO api_keys (user_id, name, key_hash, prefix, scopes)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, name, prefix, scopes, status, last_used_at, revoked_at, created_at`,
      [userId, trim(req.body?.name) || 'OMS App Studio API key', keyHash, prefix, scopes],
    );
    await writeLedger(userId, {
      entityType: 'oms_api_key',
      entityId: row?.id,
      eventType: 'created',
      summary: `OMS API key ${row?.name || prefix} created.`,
      payload: { scopes },
    });
    return { apiKey: raw, key: mapApiKey(row || {}), warning: 'Save this key now. It is not shown again.' };
  });

  app.post('/oms/api-keys/:id/rotate', async (req: any, reply) => {
    const userId = requireJwtUser(req, reply);
    if (!userId) return;
    const raw = `uc_${randomBytes(24).toString('hex')}`;
    const keyHash = createHash('sha256').update(raw).digest('hex');
    const prefix = raw.slice(0, 10);
    const row = await one(
      `UPDATE api_keys
       SET key_hash = $3, prefix = $4, status = 'active', revoked_at = NULL, last_used_at = NULL
       WHERE id = $1 AND user_id = $2
       RETURNING id, name, prefix, scopes, status, last_used_at, revoked_at, created_at`,
      [req.params.id, userId, keyHash, prefix],
    );
    if (!row) return reply.code(404).send({ error: 'API key not found' });
    await writeLedger(userId, {
      entityType: 'oms_api_key',
      entityId: row.id,
      eventType: 'rotated',
      summary: `OMS API key ${row.name || prefix} rotated.`,
      payload: { prefix },
    });
    return { apiKey: raw, key: mapApiKey(row), warning: 'Save this rotated key now. It is not shown again.' };
  });

  app.post('/oms/api-keys/:id/revoke', async (req: any, reply) => {
    const userId = requireJwtUser(req, reply);
    if (!userId) return;
    const row = await one(
      `UPDATE api_keys
       SET status = 'revoked', revoked_at = now()
       WHERE id = $1 AND user_id = $2
       RETURNING id, name, prefix, scopes, status, last_used_at, revoked_at, created_at`,
      [req.params.id, userId],
    );
    if (!row) return reply.code(404).send({ error: 'API key not found' });
    await writeLedger(userId, {
      entityType: 'oms_api_key',
      entityId: row.id,
      eventType: 'revoked',
      summary: `OMS API key ${row.name || row.prefix} revoked.`,
      payload: { prefix: row.prefix },
    });
    return { success: true, key: mapApiKey(row) };
  });
}
