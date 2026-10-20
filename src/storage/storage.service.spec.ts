import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { StorageService, MAX_SELF_UPLOAD_BYTES } from './storage.service';
import type { PrismaService } from '../prisma/prisma.service';

// §5 of cartman-server-endpoints.md: customer/rider uploads must land in a
// self-scoped prefix (avatars/{uid}/…) in the default bucket, with an
// image-only allowlist and a size cap. Merchants get the same limits and are
// confined to stores|menu/{a store they belong to}/…. Only admin keeps a
// free-form bucket/path. resolveUploadTarget is the policy — the network
// upload itself stays in uploadFile.
describe('StorageService.resolveUploadTarget', () => {
  let prisma: { merchant_users: { findFirst: jest.Mock } };
  let service: StorageService;

  beforeEach(() => {
    prisma = { merchant_users: { findFirst: jest.fn() } };
    service = new StorageService(prisma as unknown as PrismaService);
  });

  const imageFile = {
    originalname: 'pic.jpg',
    mimetype: 'image/jpeg',
    size: 1024,
  } as Express.Multer.File;

  const customer = { id: 'cust-1', role: 'customer' };

  it('scopes a customer upload to avatars/{uid}/ keeping only the basename', async () => {
    const target = await service.resolveUploadTarget(
      customer,
      imageFile,
      'cartman-assets',
      'avatars/cust-1.jpg',
    );

    expect(target).toEqual({
      bucket: 'cartman-assets',
      path: 'avatars/cust-1/cust-1.jpg',
    });
  });

  it('neutralizes .. traversal segments in the requested path', async () => {
    const target = await service.resolveUploadTarget(
      customer,
      imageFile,
      'cartman-assets',
      '../../private/secrets.jpg',
    );

    expect(target.path).toBe('avatars/cust-1/secrets.jpg');
    expect(target.path).not.toContain('..');
  });

  it("cannot write into another user's prefix", async () => {
    const target = await service.resolveUploadTarget(
      customer,
      imageFile,
      'cartman-assets',
      'avatars/other-user/pic.jpg',
    );

    expect(target.path.startsWith('avatars/cust-1/')).toBe(true);
    expect(target.path).not.toContain('other-user');
  });

  it('ignores a caller-chosen bucket for customers (forced to the default)', async () => {
    const target = await service.resolveUploadTarget(
      customer,
      imageFile,
      'some-private-bucket',
      'avatars/pic.jpg',
    );

    expect(target.bucket).toBe('cartman-assets');
  });

  it('generates a name under the self prefix when no path is supplied', async () => {
    const target = await service.resolveUploadTarget(
      customer,
      imageFile,
      'cartman-assets',
      undefined,
    );

    expect(target.path.startsWith('avatars/cust-1/')).toBe(true);
    expect(target.path.endsWith('pic.jpg')).toBe(true);
  });

  it('self-scopes riders the same way (POD photos)', async () => {
    const target = await service.resolveUploadTarget(
      { id: 'rider-9', role: 'rider' },
      imageFile,
      'cartman-assets',
      'pod/receipt.png',
    );

    expect(target.path.startsWith('avatars/rider-9/')).toBe(true);
  });

  it('rejects non-image uploads from customers', async () => {
    await expect(
      service.resolveUploadTarget(
        customer,
        { ...imageFile, mimetype: 'application/pdf' },
        'cartman-assets',
        'avatars/doc.pdf',
      ),
    ).rejects.toThrow(BadRequestException);
  });

  // The default bucket is public, so whatever lands there is served from the
  // project's own origin. An SVG is an image/* that can carry script; the
  // bucket's allowed_mime_types (cartman-mobile 20261020130000) refuses it
  // too, and refusing it here makes that a clean 400 instead of a storage
  // error surfacing as a 500.
  it('rejects an SVG, and any image type the bucket does not take', async () => {
    for (const mimetype of ['image/svg+xml', 'image/gif']) {
      await expect(
        service.resolveUploadTarget(
          customer,
          { ...imageFile, mimetype },
          'cartman-assets',
          'avatars/pic',
        ),
      ).rejects.toThrow(BadRequestException);
    }
  });

  it('takes the three photo types the apps and the panel send', async () => {
    for (const mimetype of ['image/jpeg', 'image/png', 'image/webp']) {
      await expect(
        service.resolveUploadTarget(
          customer,
          { ...imageFile, mimetype },
          'cartman-assets',
          'avatars/pic',
        ),
      ).resolves.toMatchObject({ bucket: 'cartman-assets' });
    }
  });

  it('rejects customer uploads over the size cap', async () => {
    await expect(
      service.resolveUploadTarget(
        customer,
        {
          ...imageFile,
          size: MAX_SELF_UPLOAD_BYTES + 1,
        },
        'cartman-assets',
        'avatars/huge.jpg',
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it('leaves admin uploads untouched (any bucket, any path, any type)', async () => {
    const target = await service.resolveUploadTarget(
      { id: 'admin-1', role: 'admin' },
      { ...imageFile, mimetype: 'application/zip' },
      'ops-bucket',
      'exports/2026/report.zip',
    );

    expect(target).toEqual({
      bucket: 'ops-bucket',
      path: 'exports/2026/report.zip',
    });
  });

  // server-handoff.md §12: the Merchant Panel sends
  // stores|menu/{merchant_id}/{uuid}.jpg for store and dish photos.
  describe('merchant scope', () => {
    const merchant = { id: 'merch-user-1', role: 'merchant' };
    const storeA = '0f6a2c8e-1b1d-4c55-9a51-6f1f3d6d8a01';
    const storeB = '7c3e9d42-5a8b-4f10-8e2d-2b7c1a9e4f02';

    beforeEach(() => {
      prisma.merchant_users.findFirst.mockImplementation(
        ({ where }: { where: { user_id: string; merchant_id: string } }) =>
          Promise.resolve(
            where.user_id === merchant.id && where.merchant_id === storeA
              ? { merchant_id: storeA }
              : null,
          ),
      );
    });

    it.each(['menu', 'stores'])(
      'accepts %s/{own store}/ and keeps the key as sent',
      async (folder) => {
        const target = await service.resolveUploadTarget(
          merchant,
          imageFile,
          'cartman-assets',
          `${folder}/${storeA}/a1b2.jpg`,
        );

        expect(target).toEqual({
          bucket: 'cartman-assets',
          path: `${folder}/${storeA}/a1b2.jpg`,
        });
        expect(prisma.merchant_users.findFirst).toHaveBeenCalledWith(
          expect.objectContaining({
            where: { user_id: merchant.id, merchant_id: storeA },
          }),
        );
      },
    );

    it("403s an upload into another store's folder", async () => {
      await expect(
        service.resolveUploadTarget(
          merchant,
          imageFile,
          'cartman-assets',
          `menu/${storeB}/a1b2.jpg`,
        ),
      ).rejects.toThrow(ForbiddenException);
    });

    it.each([
      ['a folder outside stores/ and menu/', `avatars/${storeA}/a.jpg`],
      ['the pre-scope free-form key', `merchants/${storeA}/menu/burger.jpg`],
      ['a store id that is not a uuid', 'menu/not-a-uuid/a.jpg'],
      ['no file name', `menu/${storeA}`],
      ['no path at all', ''],
      [
        'a traversal out of the store folder',
        `menu/${storeA}/../${storeB}/a.jpg`,
      ],
    ])('403s %s', async (_label, path) => {
      await expect(
        service.resolveUploadTarget(
          merchant,
          imageFile,
          'cartman-assets',
          path,
        ),
      ).rejects.toThrow(ForbiddenException);
    });

    it('does not look up membership for a malformed path', async () => {
      await expect(
        service.resolveUploadTarget(
          merchant,
          imageFile,
          'cartman-assets',
          'menu/not-a-uuid/a.jpg',
        ),
      ).rejects.toThrow(ForbiddenException);
      // A non-uuid would reach Postgres as a cast error, i.e. a 500.
      expect(prisma.merchant_users.findFirst).not.toHaveBeenCalled();
    });

    it('forces the default bucket, so the private merchant-docs bucket is out of reach', async () => {
      const target = await service.resolveUploadTarget(
        merchant,
        imageFile,
        'merchant-docs',
        `stores/${storeA}/a1b2.jpg`,
      );

      expect(target.bucket).toBe('cartman-assets');
    });

    it('rejects non-image uploads from merchants', async () => {
      await expect(
        service.resolveUploadTarget(
          merchant,
          { ...imageFile, mimetype: 'application/pdf' },
          'cartman-assets',
          `menu/${storeA}/menu.pdf`,
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects merchant uploads over the size cap', async () => {
      await expect(
        service.resolveUploadTarget(
          merchant,
          { ...imageFile, size: MAX_SELF_UPLOAD_BYTES + 1 },
          'cartman-assets',
          `menu/${storeA}/huge.jpg`,
        ),
      ).rejects.toThrow(BadRequestException);
    });
  });
});
