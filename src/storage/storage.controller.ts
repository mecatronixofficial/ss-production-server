import { Controller, Post, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { FileInterceptor } from '@nestjs/platform-express';
import { StorageService } from './storage.service';

@Controller('files')
@UseGuards(AuthGuard('jwt'))
export class StorageController {
  constructor(private storage: StorageService) {}

  @Post('upload')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 10 * 1024 * 1024, files: 1 } }))
  upload(@UploadedFile() file?: Express.Multer.File) {
    return this.storage.upload(file);
  }
}
