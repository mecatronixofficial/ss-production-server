import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { S3Client } from '@aws-sdk/client-s3';
import { mkdir, readFile, rm, writeFile } from 'fs/promises';
import { dirname, join, resolve } from 'path';
import { randomUUID } from 'crypto';

export const ALLOWED_UPLOAD_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/pdf',
  'text/csv',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
]);

@Injectable()
export class StorageService {
  private readonly logger = new Logger(StorageService.name);
  private readonly bucket?: string;
  private readonly r2?: { endpoint: string; key: string; secret: string };
  private s3?: Promise<{ client: S3Client; sdk: typeof import('@aws-sdk/client-s3') }>;

  constructor(private config: ConfigService) {
    const account = this.config.get<string>('R2_ACCOUNT_ID');
    const key = this.config.get<string>('R2_ACCESS_KEY_ID');
    const secret = this.config.get<string>('R2_SECRET_ACCESS_KEY');
    const endpoint = account ? `https://${account}.r2.cloudflarestorage.com` : this.config.get<string>('R2_ENDPOINT');
    this.bucket = this.config.get<string>('R2_BUCKET') || this.config.get<string>('R2_BUCKET_NAME');
    if (endpoint && key && secret && this.bucket) {
      this.r2 = { endpoint, key, secret };
    } else {
      this.logger.log('R2 is not configured; uploads are stored on local disk');
    }
  }

  /** The S3 SDK is large; it loads on the first file operation instead of slowing every server start. */
  private storage() {
    if (!this.r2) return undefined;
    const { endpoint, key, secret } = this.r2;
    this.s3 ??= import('@aws-sdk/client-s3').then((sdk) => ({
      sdk,
      client: new sdk.S3Client({ region: 'auto', endpoint, credentials: { accessKeyId: key, secretAccessKey: secret } }),
    }));
    return this.s3;
  }

  async upload(file: { originalname: string; mimetype: string; buffer: Buffer } | undefined) {
    if (!file?.buffer?.length) throw new BadRequestException('Attach a file in the "file" field');
    if (!ALLOWED_UPLOAD_TYPES.has(file.mimetype)) throw new BadRequestException(`File type ${file.mimetype} is not allowed`);

    const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_').slice(-120);
    const key = `erp/${new Date().toISOString().slice(0, 10)}/${randomUUID()}-${safe}`;
    const s3 = await this.storage();
    if (s3 && this.bucket) {
      await s3.client.send(new s3.sdk.PutObjectCommand({ Bucket: this.bucket, Key: key, Body: file.buffer, ContentType: file.mimetype }));
      return { objectKey: key, storage: 'r2' };
    }
    const target = this.localPath(key);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, file.buffer);
    return { objectKey: key, storage: 'local' };
  }

  /** The bytes of an uploaded file, for serving it back to signed-in users. */
  async download(objectKey: string): Promise<Buffer> {
    const s3 = await this.storage();
    if (s3 && this.bucket) {
      const result = await s3.client.send(new s3.sdk.GetObjectCommand({ Bucket: this.bucket, Key: objectKey }));
      if (!result.Body) throw new NotFoundException('File not found');
      return Buffer.from(await result.Body.transformToByteArray());
    }
    try {
      return await readFile(this.localPath(objectKey));
    } catch {
      throw new NotFoundException('File not found');
    }
  }

  /** Best effort: a file that is already gone is not an error. */
  async remove(objectKey: string) {
    try {
      const s3 = await this.storage();
      if (s3 && this.bucket) await s3.client.send(new s3.sdk.DeleteObjectCommand({ Bucket: this.bucket, Key: objectKey }));
      else await rm(this.localPath(objectKey), { force: true });
    } catch (error) {
      this.logger.warn(`Could not delete ${objectKey}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** A key's place under the local upload folder; keys never leave it. */
  private localPath(objectKey: string) {
    const base = resolve(this.config.get('LOCAL_UPLOAD_DIR', './uploads'));
    const target = resolve(join(base, objectKey));
    if (!target.startsWith(base)) throw new BadRequestException('Invalid file key');
    return target;
  }
}
