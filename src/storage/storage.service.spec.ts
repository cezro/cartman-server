import { BadRequestException } from '@nestjs/common';
import { StorageService, MAX_SELF_UPLOAD_BYTES } from './storage.service';

// §5 of cartman-server-endpoints.md: customer/rider uploads must land in a
// self-scoped prefix (avatars/{uid}/…) in the default bucket, with an
// image-only allowlist and a size cap. Admin/merchant keep their existing
// free-form bucket/path behavior. resolveUploadTarget is the pure policy —
// the network upload itself stays in uploadFile.
describe('StorageService.resolveUploadTarget', () => {
  const service = new StorageService();

  const imageFile = {
    originalname: 'pic.jpg',
    mimetype: 'image/jpeg',
    size: 1024,
  } as Express.Multer.File;

  const customer = { id: 'cust-1', role: 'customer' };

  it('scopes a customer upload to avatars/{uid}/ keeping only the basename', () => {
    const target = service.resolveUploadTarget(
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

  it('neutralizes .. traversal segments in the requested path', () => {
    const target = service.resolveUploadTarget(
      customer,
      imageFile,
      'cartman-assets',
      '../../private/secrets.jpg',
    );

    expect(target.path).toBe('avatars/cust-1/secrets.jpg');
    expect(target.path).not.toContain('..');
  });

  it("cannot write into another user's prefix", () => {
    const target = service.resolveUploadTarget(
      customer,
      imageFile,
      'cartman-assets',
      'avatars/other-user/pic.jpg',
    );

    expect(target.path.startsWith('avatars/cust-1/')).toBe(true);
    expect(target.path).not.toContain('other-user');
  });

  it('ignores a caller-chosen bucket for customers (forced to the default)', () => {
    const target = service.resolveUploadTarget(
      customer,
      imageFile,
      'some-private-bucket',
      'avatars/pic.jpg',
    );

    expect(target.bucket).toBe('cartman-assets');
  });

  it('generates a name under the self prefix when no path is supplied', () => {
    const target = service.resolveUploadTarget(
      customer,
      imageFile,
      'cartman-assets',
      undefined,
    );

    expect(target.path.startsWith('avatars/cust-1/')).toBe(true);
    expect(target.path.endsWith('pic.jpg')).toBe(true);
  });

  it('self-scopes riders the same way (POD photos)', () => {
    const target = service.resolveUploadTarget(
      { id: 'rider-9', role: 'rider' },
      imageFile,
      'cartman-assets',
      'pod/receipt.png',
    );

    expect(target.path.startsWith('avatars/rider-9/')).toBe(true);
  });

  it('rejects non-image uploads from customers', () => {
    expect(() =>
      service.resolveUploadTarget(
        customer,
        { ...imageFile, mimetype: 'application/pdf' },
        'cartman-assets',
        'avatars/doc.pdf',
      ),
    ).toThrow(BadRequestException);
  });

  it('rejects customer uploads over the size cap', () => {
    expect(() =>
      service.resolveUploadTarget(
        customer,
        {
          ...imageFile,
          size: MAX_SELF_UPLOAD_BYTES + 1,
        },
        'cartman-assets',
        'avatars/huge.jpg',
      ),
    ).toThrow(BadRequestException);
  });

  it('leaves admin uploads untouched (any bucket, any path, any type)', () => {
    const target = service.resolveUploadTarget(
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

  it('leaves merchant uploads untouched (menu images flow)', () => {
    const target = service.resolveUploadTarget(
      { id: 'merch-1', role: 'merchant' },
      imageFile,
      'cartman-assets',
      'merchants/store-1/menu/burger.jpg',
    );

    expect(target.path).toBe('merchants/store-1/menu/burger.jpg');
  });
});
