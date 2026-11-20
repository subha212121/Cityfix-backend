import { Router } from 'express';
import { z } from 'zod';
import { actorOf } from '../../lib/http.js';
import { ALLOWED_IMAGE_TYPES, MAX_PHOTO_BYTES, presignUpload, type ImageType } from '../../lib/storage.js';
import { requireAuth } from '../../middleware/auth.js';

export const uploadsRouter = Router();
uploadsRouter.use(requireAuth);

// POST /uploads/presign — the app uploads the photo straight to storage, then
// passes the returned storage_key when creating the incident (FR-06).
uploadsRouter.post('/presign', async (req, res) => {
  const a = actorOf(req);
  const b = z
    .object({
      mime_type: z.enum(Object.keys(ALLOWED_IMAGE_TYPES) as [ImageType, ...ImageType[]], { message: 'Only JPG or PNG photos' }),
      size_bytes: z.number().int().positive().max(MAX_PHOTO_BYTES, 'Each photo can be up to 5 MB'),
    })
    .parse(req.body);
  res.status(201).json(await presignUpload(a.userId, b.mime_type, b.size_bytes));
});
