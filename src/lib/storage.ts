/**
 * File storage for photos and exports, behind one small interface:
 *
 *   STORAGE_DRIVER=local (default)  files live in LOCAL_STORAGE_DIR on this machine.
 *       Uploads and downloads use short-lived signed URLs served by this API
 *       (PUT /api/v1/files/upload/:token, GET /api/v1/files/:token), so the
 *       apps use exactly the same flow as with S3.
 *   STORAGE_DRIVER=s3               any S3-compatible service (AWS S3, Cloudflare R2, ...).
 *
 * Callers never see which driver is active.
 */
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import jwt from 'jsonwebtoken';
import { S3Client, PutObjectCommand, GetObjectCommand, CreateBucketCommand, HeadBucketCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { config } from '../config.js';

export const ALLOWED_IMAGE_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png' } as const;
export type ImageType = keyof typeof ALLOWED_IMAGE_TYPES;
export const MAX_PHOTO_BYTES = 5 * 1024 * 1024;

/** Keys a user may attach are always under their own upload prefix. */
export const uploadPrefix = (userId: string) => `uploads/${userId}/`;

const isLocal = () => config.STORAGE_DRIVER === 'local';
const UPLOAD_TTL = 600;

// ---------------------------------------------------------------------------
// Local driver
// ---------------------------------------------------------------------------
export const localRoot = () => path.resolve(config.LOCAL_STORAGE_DIR);

/** Server-generated keys only: letters, digits, / _ . -  and never "..". */
export function localPath(key: string) {
  if (!/^[A-Za-z0-9/_.-]+$/.test(key) || key.includes('..') || key.startsWith('/')) throw new Error('Invalid storage key');
  const full = path.resolve(localRoot(), key);
  if (!full.startsWith(localRoot() + path.sep)) throw new Error('Invalid storage key');
  return full;
}

interface FileClaims {
  k: string; // storage key
  op: 'put' | 'get';
  m?: string; // content type allowed for upload
  s?: number; // max bytes for upload
}
const signFileToken = (c: FileClaims, ttl: number) =>
  jwt.sign(c, config.JWT_SECRET, { expiresIn: ttl, audience: 'cityfix-files', issuer: 'cityfix-api' });

export function verifyFileToken(token: string, op: 'put' | 'get'): FileClaims {
  const c = jwt.verify(token, config.JWT_SECRET, { audience: 'cityfix-files', issuer: 'cityfix-api' }) as FileClaims;
  if (c.op !== op) throw new Error('Wrong token type');
  return c;
}

/** JPG starts FF D8 FF; PNG starts 89 50 4E 47. Stops non-images being stored as photos. */
export function looksLike(mime: string, buf: Buffer) {
  if (mime === 'image/jpeg') return buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  if (mime === 'image/png') return buf.length > 4 && buf.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  return true;
}

export async function writeLocal(key: string, body: Buffer | string) {
  const file = localPath(key);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, body);
}

// ---------------------------------------------------------------------------
// S3 driver
// ---------------------------------------------------------------------------
const makeClient = (endpoint?: string) =>
  new S3Client({
    region: config.S3_REGION,
    endpoint,
    forcePathStyle: config.S3_FORCE_PATH_STYLE,
    credentials: { accessKeyId: config.S3_ACCESS_KEY_ID, secretAccessKey: config.S3_SECRET_ACCESS_KEY },
  });
let s3: S3Client | undefined;
let signer: S3Client | undefined;
const s3Client = () => (s3 ??= makeClient(config.S3_ENDPOINT));
const s3Signer = () => (signer ??= makeClient(config.S3_PUBLIC_ENDPOINT ?? config.S3_ENDPOINT));

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------
export async function presignUpload(userId: string, mime: ImageType, sizeBytes: number) {
  const key = `${uploadPrefix(userId)}${crypto.randomUUID()}.${ALLOWED_IMAGE_TYPES[mime]}`;
  const url = isLocal()
    ? `${config.PUBLIC_API_URL}/api/v1/files/upload/${signFileToken({ k: key, op: 'put', m: mime, s: sizeBytes }, UPLOAD_TTL)}`
    : await getSignedUrl(
        s3Signer(),
        new PutObjectCommand({ Bucket: config.S3_BUCKET, Key: key, ContentType: mime, ContentLength: sizeBytes }),
        { expiresIn: UPLOAD_TTL },
      );
  return { storage_key: key, upload_url: url, method: 'PUT', headers: { 'Content-Type': mime }, expires_in: UPLOAD_TTL };
}

export const presignDownload = async (key: string, expiresIn = 900) =>
  isLocal()
    ? `${config.PUBLIC_API_URL}/api/v1/files/${signFileToken({ k: key, op: 'get' }, expiresIn)}`
    : getSignedUrl(s3Signer(), new GetObjectCommand({ Bucket: config.S3_BUCKET, Key: key }), { expiresIn });

export async function putObject(key: string, body: Buffer | string, contentType: string) {
  if (isLocal()) return writeLocal(key, body);
  await s3Client().send(new PutObjectCommand({ Bucket: config.S3_BUCKET, Key: key, Body: body, ContentType: contentType }));
}

/** Local: create the folder. S3: create the bucket if missing. */
export async function ensureBucket() {
  if (isLocal()) {
    await fs.mkdir(localRoot(), { recursive: true });
    return `local folder ${localRoot()}`;
  }
  try {
    await s3Client().send(new HeadBucketCommand({ Bucket: config.S3_BUCKET }));
  } catch {
    await s3Client().send(new CreateBucketCommand({ Bucket: config.S3_BUCKET }));
  }
  return `S3 bucket ${config.S3_BUCKET}`;
}

export const storageDriver = () => config.STORAGE_DRIVER;
