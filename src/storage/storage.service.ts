import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
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
  private readonly s3?: S3Client;
  private readonly bucket?: string;

  constructor(private config: ConfigService) {
    const account = this.config.get<string>('R2_ACCOUNT_ID');
    const key = this.config.get<string>('R2_ACCESS_KEY_ID');
    const secret = this.config.get<string>('R2_SECRET_ACCESS_KEY');
    const endpoint = account ? `https://${account}.r2.cloudflarestorage.com` : this.config.get<string>('R2_ENDPOINT');
    this.bucket = this.config.get<string>('R2_BUCKET') || this.config.get<string>('R2_BUCKET_NAME');
    if (endpoint && key && secret && this.bucket) {
      this.s3 = new S3Client({ region: 'auto', endpoint, credentials: { accessKeyId: key, secretAccessKey: secret } });
    } else {
      this.logger.log('R2 is not configured; uploads are stored on local disk');
    }
  }

  async upload(file: { originalname: string; mimetype: string; buffer: Buffer } | undefined) {
    if (!file?.buffer?.length) throw new BadRequestException('Attach a file in the "file" field');
    if (!ALLOWED_UPLOAD_TYPES.has(file.mimetype)) throw new BadRequestException(`File type ${file.mimetype} is not allowed`);

    const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_').slice(-120);
    const key = `erp/${new Date().toISOString().slice(0, 10)}/${randomUUID()}-${safe}`;
    if (this.s3 && this.bucket) {
      await this.s3.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: file.buffer, ContentType: file.mimetype }));
      return { objectKey: key, storage: 'r2' };
    }
    const target = this.localPath(key);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, file.buffer);
    return { objectKey: key, storage: 'local' };
  }

  /** The bytes of an uploaded file, for serving it back to signed-in users. */
  async download(objectKey: string): Promise<Buffer> {
    if (this.s3 && this.bucket) {
      const result = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: objectKey }));
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
      if (this.s3 && this.bucket) await this.s3.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: objectKey }));
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
