import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { readFile } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import type { Readable } from "node:stream";
import { config } from "./config.js";

/**
 * Any S3-compatible object storage (DigitalOcean Spaces, Storj, AWS S3, …) —
 * the same SDK works once `endpoint` + `region` are set.
 * `forcePathStyle: true` keeps URLs in `endpoint/bucket/key` form, which both
 * DO Spaces and Storj support without DNS for virtual-hosted style.
 */
const s3 = new S3Client({
  endpoint: config.s3.endpoint,
  region: config.s3.region,
  forcePathStyle: true,
  credentials: {
    accessKeyId: config.s3.accessKeyId,
    secretAccessKey: config.s3.secretAccessKey,
  },
  // AWS SDK v3 (≥3.729) defaults to adding a CRC32 checksum to every request.
  // For browser-direct presigned PUTs the SDK can't see the body at sign time,
  // so it signs in the CRC32 of an empty body — DO Spaces / MinIO / R2 then
  // reject the upload with HTTP 400 because the actual body's CRC32 differs.
  // "WHEN_REQUIRED" stops the SDK from adding any checksum unless AWS itself
  // mandates one (it doesn't, for plain PutObject). Match for response side.
  requestChecksumCalculation: "WHEN_REQUIRED",
  responseChecksumValidation: "WHEN_REQUIRED",
});

const BUCKET = config.s3.bucket;

/**
 * Upload a local file to object storage. Returns the object key.
 *
 * We read the file into a Buffer instead of streaming because some S3-compatible
 * gateways (including Storj's) strictly require `Content-Length`, and AWS SDK v3
 * doesn't always propagate it for stream bodies — even when ContentLength is set
 * explicitly.
 *
 * Trade-off: holds the whole file in memory. For our pipeline the largest is the
 * extracted audio WAV (~32KB/sec at 16kHz mono), so a 1-hour video = ~115MB.
 * If we ever need to support multi-hour uploads, switch to @aws-sdk/lib-storage's
 * `Upload` class which handles multipart automatically.
 */
export async function uploadFile(
  localPath: string,
  key: string,
  contentType: string,
): Promise<string> {
  const data = await readFile(localPath);
  await s3.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: data,
      ContentType: contentType,
      ContentLength: data.length,
    }),
  );
  return key;
}

/** Upload a Buffer (e.g. TTS audio) directly without touching disk. */
export async function uploadBuffer(
  data: Buffer,
  key: string,
  contentType: string,
): Promise<string> {
  await s3.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: data,
      ContentType: contentType,
      ContentLength: data.length,
    }),
  );
  return key;
}

/** Time-limited URL the browser can fetch directly. */
export async function presignDownload(key: string, ttlSeconds = 3600): Promise<string> {
  return getSignedUrl(
    s3,
    new GetObjectCommand({ Bucket: BUCKET, Key: key }),
    { expiresIn: ttlSeconds },
  );
}

/**
 * Time-limited URL the browser can PUT to (skip-the-server upload pattern).
 * Default TTL is 2h — long enough that a multi-GB video over a typical home
 * connection completes before the URL expires. (Short TTLs were causing
 * silent 403s mid-upload on 2-cag videos.)
 */
export async function presignUpload(
  key: string,
  contentType: string,
  ttlSeconds = 7200,
): Promise<string> {
  return getSignedUrl(
    s3,
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      ContentType: contentType,
    }),
    { expiresIn: ttlSeconds },
  );
}

/**
 * Pull an object into memory as a Buffer. Use for SMALL objects only — audio
 * clips, SRT files, anything under ~100MB. For raw video pulls use
 * `downloadToFile` to avoid loading multi-GB blobs into the Node heap.
 */
export async function downloadToBuffer(key: string): Promise<Buffer> {
  const resp = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  if (!resp.Body) throw new Error(`No body for key ${key}`);
  const chunks: Uint8Array[] = [];
  // Body is typed as a union of stream types — at Node runtime it's an
  // AsyncIterable<Uint8Array>, which is what we need here.
  for await (const chunk of resp.Body as AsyncIterable<Uint8Array>) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/**
 * Stream an object straight to a local file path. Use this for any payload
 * that could be larger than ~100MB (raw videos, especially) — pipelining
 * S3 → disk keeps Node's heap flat regardless of file size.
 */
export async function downloadToFile(key: string, localPath: string): Promise<void> {
  const resp = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  if (!resp.Body) throw new Error(`No body for key ${key}`);
  await pipeline(resp.Body as Readable, createWriteStream(localPath));
}

/**
 * Pull a remote URL straight to a local file path, streaming through Node
 * (so we never hold the whole payload in memory). Returns the resolved
 * Content-Type so callers can pick the right S3 object extension/mime.
 *
 * The caller is responsible for handling YouTube/Vimeo URLs separately —
 * this helper only knows how to GET a direct file URL.
 */
export async function downloadUrlToFile(
  url: string,
  localPath: string,
): Promise<{ contentType: string }> {
  const resp = await fetch(url, { redirect: "follow" });
  if (!resp.ok) {
    throw new Error(`URL fetch failed: ${resp.status} ${resp.statusText}`);
  }
  if (!resp.body) throw new Error("URL response had no body");
  const contentType =
    resp.headers.get("content-type")?.split(";")[0].trim() ??
    "application/octet-stream";
  // node:18+ fetch returns a WHATWG ReadableStream; pipeline accepts it via
  // the Node 18 interop layer when cast to any.
  await pipeline(
    resp.body as unknown as Readable,
    createWriteStream(localPath),
  );
  return { contentType };
}
