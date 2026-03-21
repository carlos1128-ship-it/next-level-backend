import { Module } from '@nestjs/common';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { BackupService } from './backup.service';
import { AdminGuard } from '../../common/guards/admin.guard';

@Module({
  controllers: [AdminController],
  providers: [AdminService, BackupService, AdminGuard],
})
export class AdminModule {}
