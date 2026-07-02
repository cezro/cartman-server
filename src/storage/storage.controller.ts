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
import { StorageService } from './storage.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles } from '../auth/roles.decorator';

@Controller('storage')
@UseGuards(JwtAuthGuard)
export class StorageController {
  constructor(private readonly storageService: StorageService) {}

  @Post('upload')
  @Roles('admin', 'merchant')
  @UseInterceptors(FileInterceptor('file'))
  async uploadFile(
    @UploadedFile() file: Express.Multer.File,
    @Body('bucket') bucket: string = 'cartman-assets',
    @Body('path') path: string,
  ) {
    if (!file) {
      throw new BadRequestException('No file provided');
    }
    const fileName = path || `${Date.now()}-${file.originalname}`;
    return this.storageService.uploadFile(file, bucket, fileName);
  }
}
