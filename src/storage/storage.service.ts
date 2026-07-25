import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
} from '@nestjs/common';
import { createClient } from '@supabase/supabase-js';

export const DEFAULT_BUCKET = 'cartman-assets';
export const MAX_SELF_UPLOAD_BYTES = 5 * 1024 * 1024; // 5 MB

@Injectable()
export class StorageService {
  private supabase;

  constructor() {
    this.supabase = createClient(
      process.env.SUPABASE_URL || 'http://localhost:54321',
      process.env.SUPABASE_SERVICE_ROLE_KEY || 'dummy_key',
    );
  }

  /**
   * Upload policy (cartman-server-endpoints.md §5). Admin/merchant keep
   * free-form bucket/path (menu images, ops exports). Customer/rider uploads
   * are image-only, size-capped, and always land in avatars/{uid}/ in the
   * default bucket — the key is rebuilt from the basename of the requested
   * path, so `..` segments, another user's uid, or a caller-chosen bucket
   * can never escape the caller's own prefix.
   */
  resolveUploadTarget(
    actor: { id: string; role: string },
    file: Express.Multer.File,
    bucket: string,
    path?: string,
  ): { bucket: string; path: string } {
    if (actor.role === 'admin' || actor.role === 'merchant') {
      return {
        bucket,
        path: path || `${Date.now()}-${file.originalname}`,
      };
    }

    if (!file.mimetype?.startsWith('image/')) {
      throw new BadRequestException('Only image uploads are allowed');
    }
    if (file.size > MAX_SELF_UPLOAD_BYTES) {
      throw new BadRequestException('File exceeds the 5 MB upload limit');
    }

    const basename =
      (path ?? '')
        .split(/[\\/]+/)
        .filter(Boolean)
        .pop() ?? '';
    const safeName =
      basename && basename !== '.' && basename !== '..'
        ? basename
        : `${Date.now()}-${file.originalname}`;

    return {
      bucket: DEFAULT_BUCKET,
      path: `avatars/${actor.id}/${safeName}`,
    };
  }

  async uploadFile(file: Express.Multer.File, bucket: string, path: string) {
    const { data, error } = await this.supabase.storage
      .from(bucket)
      .upload(path, file.buffer, {
        contentType: file.mimetype,
        upsert: true,
      });

    if (error) {
      throw new InternalServerErrorException(error.message);
    }

    const { data: publicUrlData } = this.supabase.storage
      .from(bucket)
      .getPublicUrl(path);

    return {
      path: data.path,
      publicUrl: publicUrlData.publicUrl,
    };
  }
}
