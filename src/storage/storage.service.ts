import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
} from '@nestjs/common';
import { createClient } from '@supabase/supabase-js';
import { PrismaService } from '../prisma/prisma.service';

export const DEFAULT_BUCKET = 'cartman-assets';
export const MAX_SELF_UPLOAD_BYTES = 5 * 1024 * 1024; // 5 MB

/**
 * The photo types non-admin uploads may be — what the apps (`.jpg`) and the
 * panel's `ImageUpload` (jpeg/png/webp) send. Not `image/*`: the default
 * bucket is public and serves from the project's origin, and an SVG is an
 * image that can carry script. The bucket's `allowed_mime_types`
 * (cartman-mobile `20261020130000_cartman_assets_bucket`) holds the same list.
 */
export const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

/**
 * The folders a merchant may upload into, each keyed by store id: `stores/`
 * for the store photo (M-5.1), `menu/` for dish photos (M-4.1). These are the
 * prefixes the Merchant Panel's `ImageUpload` sends.
 */
export const MERCHANT_UPLOAD_FOLDERS = ['stores', 'menu'] as const;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const NOT_YOUR_STORE =
  'Photos can only be uploaded to stores/{store id}/ or menu/{store id}/ for a store you belong to';

@Injectable()
export class StorageService {
  private supabase;

  constructor(private readonly prisma: PrismaService) {
    this.supabase = createClient(
      process.env.SUPABASE_URL || 'http://localhost:54321',
      process.env.SUPABASE_SERVICE_ROLE_KEY || 'dummy_key',
    );
  }

  /**
   * Upload policy (cartman-server-endpoints.md §5). Only admin keeps a
   * free-form bucket/path (ops exports). Everyone else uploads images only,
   * capped at 5 MB, into the default bucket, under a key rebuilt from the
   * basename of the requested path — so `..` segments or a caller-chosen
   * bucket can never escape the caller's own prefix:
   *
   * - customer/rider → `avatars/{uid}/{basename}`.
   * - merchant → `stores/{merchant_id}/{basename}` or
   *   `menu/{merchant_id}/{basename}`, and only for a store `merchant_users`
   *   links the caller to. Anything else is a 403. The bucket is forced too:
   *   uploads run as the service role, which storage policies do not stop, so
   *   a free-form bucket would reach the private `merchant-docs` bucket.
   */
  async resolveUploadTarget(
    actor: { id: string; role: string },
    file: Express.Multer.File,
    bucket: string,
    path?: string,
  ): Promise<{ bucket: string; path: string }> {
    if (actor.role === 'admin') {
      return {
        bucket,
        path: path || `${Date.now()}-${file.originalname}`,
      };
    }

    if (!ALLOWED_IMAGE_TYPES.includes(file.mimetype)) {
      throw new BadRequestException(
        'Only JPEG, PNG or WebP photos can be uploaded',
      );
    }
    if (file.size > MAX_SELF_UPLOAD_BYTES) {
      throw new BadRequestException('File exceeds the 5 MB upload limit');
    }

    const segments = (path ?? '').split(/[\\/]+/).filter(Boolean);
    const basename = segments.at(-1) ?? '';
    const safeName =
      basename && basename !== '.' && basename !== '..'
        ? basename
        : `${Date.now()}-${file.originalname}`;

    if (actor.role === 'merchant') {
      const [folder, merchantId] = segments;
      // Exactly folder/id/name: a deeper key would be kept only as its
      // basename, and a shorter one names no store.
      if (
        segments.length !== 3 ||
        !(MERCHANT_UPLOAD_FOLDERS as readonly string[]).includes(folder) ||
        !UUID_RE.test(merchantId)
      ) {
        throw new ForbiddenException(NOT_YOUR_STORE);
      }
      const membership = await this.prisma.merchant_users.findFirst({
        where: { user_id: actor.id, merchant_id: merchantId },
        select: { merchant_id: true },
      });
      if (!membership) {
        throw new ForbiddenException(NOT_YOUR_STORE);
      }
      return {
        bucket: DEFAULT_BUCKET,
        path: `${folder}/${merchantId.toLowerCase()}/${safeName}`,
      };
    }

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
