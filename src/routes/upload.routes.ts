import { randomUUID } from 'crypto';
import { Readable } from 'stream';
import { FastifyInstance } from 'fastify';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { config } from '../config/env';
import { pgQuery } from '../db/postgres';

const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

function requireUser(req: any, reply: any): string | null {
  const userId = req.user?.userId;
  if (!userId) {
    reply.code(401).send({ error: 'Unauthorized' });
    return null;
  }
  return String(userId);
}

function safeFileName(value: unknown) {
  const raw = String(value || 'image').trim() || 'image';
  const cleaned = raw.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return cleaned.slice(0, 90) || 'image';
}

function decodeImage(dataBase64: string) {
  const data = dataBase64.includes(',') ? dataBase64.split(',').pop() || '' : dataBase64;
  return Buffer.from(data, 'base64');
}

function imageResponseUrl(key: string) {
  return `${config.apiBaseUrl}/api/v1/uploads/images?key=${encodeURIComponent(key)}`;
}

async function streamToBuffer(body: any): Promise<Buffer> {
  if (!body) return Buffer.alloc(0);
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof Uint8Array) return Buffer.from(body);
  if (typeof body.transformToByteArray === 'function') {
    return Buffer.from(await body.transformToByteArray());
  }
  const stream = body as Readable;
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    stream.on('error', reject);
    stream.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

function s3() {
  return new S3Client({ region: config.uploads.s3Region });
}

export async function uploadRoutes(app: FastifyInstance) {
  app.post('/uploads/images', async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    if (!config.uploads.s3Bucket) {
      return reply.code(503).send({ error: 'S3 upload bucket is not configured' });
    }

    const body = req.body || {};
    const filename = safeFileName(body.filename);
    const contentType = String(body.contentType || '').toLowerCase();
    if (!IMAGE_TYPES.has(contentType)) {
      return reply.code(400).send({ error: 'Only JPEG, PNG, WebP, and GIF images are supported' });
    }
    if (!body.dataBase64) {
      return reply.code(400).send({ error: 'dataBase64 is required' });
    }

    const image = decodeImage(String(body.dataBase64));
    if (!image.length || image.length > config.uploads.maxImageBytes) {
      return reply.code(400).send({
        error: `Image must be between 1 byte and ${Math.floor(config.uploads.maxImageBytes / 1024 / 1024)} MB`,
      });
    }

    const purpose = String(body.purpose || '').toLowerCase();
    const folder = purpose === 'profile-avatar' ? 'profile-avatars' : 'catalog-images';
    const key = `oms/${userId}/${folder}/${randomUUID()}-${filename}`;
    await s3().send(
      new PutObjectCommand({
        Bucket: config.uploads.s3Bucket,
        Key: key,
        Body: image,
        ContentType: contentType,
        CacheControl: 'private, max-age=86400',
        Metadata: {
          userId,
          originalFilename: filename,
          source: 'unieconnect-oms',
        },
      }),
    );

    const url = imageResponseUrl(key);
    if (purpose === 'profile-avatar') {
      await pgQuery('UPDATE app_users SET avatar_url = $2, updated_at = now() WHERE id = $1', [userId, url]);
    }

    return {
      key,
      bucket: config.uploads.s3Bucket,
      contentType,
      size: image.length,
      url,
      storage: 's3',
      purpose: purpose || 'catalog-image',
    };
  });

  app.get('/uploads/images', async (req: any, reply) => {
    const userId = requireUser(req, reply);
    if (!userId) return;
    if (!config.uploads.s3Bucket) {
      return reply.code(503).send({ error: 'S3 upload bucket is not configured' });
    }

    const key = String(req.query?.key || '').trim();
    if (!key || !key.startsWith(`oms/${userId}/`)) {
      return reply.code(403).send({ error: 'Image is not available for this account' });
    }

    const object = await s3().send(
      new GetObjectCommand({
        Bucket: config.uploads.s3Bucket,
        Key: key,
      }),
    );
    const data = await streamToBuffer(object.Body);
    reply
      .header('Content-Type', object.ContentType || 'application/octet-stream')
      .header('Cache-Control', object.CacheControl || 'private, max-age=86400');
    return reply.send(data);
  });
}
