import fs from 'node:fs';
import path from 'node:path';
import express, { Router } from 'express';
import { AppError, notFound } from '../../lib/errors.js';
import { localPath, looksLike, MAX_PHOTO_BYTES, storageDriver, verifyFileToken, writeLocal } from '../../lib/storage.js';

/**
 * Signed-URL endpoints for the local storage driver. The token in the URL is
 * the permission (like an S3 presigned URL), so no Bearer token is needed.
 */
export const filesRouter = Router();

const CONTENT_TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg', '.png': 'image/png', '.csv': 'text/csv; charset=utf-8', '.pdf': 'application/pdf',
};

const claims = (token: string, op: 'put' | 'get') => {
  if (storageDriver() !== 'local') throw notFound('File');
  try {
    return verifyFileToken(token, op);
  } catch {
    throw new AppError(403, 'link_expired', 'This file link is invalid or has expired');
  }
};

// PUT /api/v1/files/upload/:token — body is the raw image bytes
filesRouter.put(
  '/upload/:token',
  express.raw({ type: () => true, limit: MAX_PHOTO_BYTES }),
  async (req, res) => {
    const c = claims(req.params.token, 'put');
    const body = req.body as Buffer;
    if (!Buffer.isBuffer(body) || body.length === 0) throw new AppError(400, 'empty_upload', 'No file was sent');
    if (c.s && body.length > c.s) throw new AppError(413, 'too_large', 'The file is larger than you said it would be');
    const sent = String(req.headers['content-type'] ?? '').split(';')[0];
    if (c.m && sent && sent !== c.m) throw new AppError(415, 'wrong_type', `Send this file as ${c.m}`);
    if (c.m && !looksLike(c.m, body)) throw new AppError(415, 'not_an_image', 'This file is not a valid JPG or PNG');
    await writeLocal(c.k, body);
    res.status(200).json({ storage_key: c.k, size_bytes: body.length });
  },
);

// GET /api/v1/files/:token — download a photo or export
filesRouter.get('/:token', (req, res) => {
  const c = claims(req.params.token, 'get');
  const file = localPath(c.k);
  if (!fs.existsSync(file)) throw notFound('File');
  res.setHeader('Content-Type', CONTENT_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream');
  res.setHeader('Cache-Control', 'private, max-age=600');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin'); // let the web app show photos
  if (/\.(csv|pdf)$/i.test(file)) res.setHeader('Content-Disposition', `attachment; filename="${path.basename(file)}"`);
  fs.createReadStream(file).pipe(res);
});
