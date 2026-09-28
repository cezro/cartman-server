import {
  Controller,
  Post,
  UseInterceptors,
  UploadedFile,
  UseGuards,
  Body,
  BadRequestException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { DEFAULT_BUCKET, StorageService } from './storage.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles } from '../auth/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/jwt.strategy';

@Controller('storage')
@UseGuards(JwtAuthGuard)
export class StorageController {
  constructor(private readonly storageService: StorageService) {}

  @Post('upload')
  // customer/rider included so mobile avatar + POD photo uploads work
  // (Phase 5). resolveUploadTarget (§5) confines them to avatars/{uid}/ and
  // merchants to stores|menu/{their store}/, all image-only and size capped.
  // Only admin keeps a free-form bucket/path.
  @Roles('admin', 'merchant', 'customer', 'rider')
  @UseInterceptors(FileInterceptor('file'))
  async uploadFile(
    @CurrentUser() user: AuthenticatedUser,
    @UploadedFile() file: Express.Multer.File,
    @Body('bucket') bucket: string = DEFAULT_BUCKET,
    @Body('path') path: string,
  ) {
    if (!file) {
      throw new BadRequestException('No file provided');
    }
    const target = await this.storageService.resolveUploadTarget(
      user,
      file,
      bucket,
      path,
    );
    return this.storageService.uploadFile(file, target.bucket, target.path);
  }
}
