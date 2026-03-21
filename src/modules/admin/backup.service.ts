import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { ActorType } from '@prisma/client';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { PrismaService } from '../../prisma/prisma.service';

const execAsync = promisify(exec);

@Injectable()
export class BackupService {
  private readonly logger = new Logger(BackupService.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  @Cron('0 2 * * *')
  async runDailyBackup() {
    const scriptPath = this.configService.get<string>('BACKUP_SCRIPT_PATH') || './scripts/backup.sh';
    const backupDir = this.configService.get<string>('BACKUP_DIR') || './backups';

    try {
      const { stdout } = await execAsync(`sh ${scriptPath}`, {
        env: {
          ...process.env,
          BACKUP_DIR: backupDir,
        },
      });

      await this.prisma.auditTrail.create({
        data: {
          actorType: ActorType.SYSTEM,
          action: 'system.backup.success',
          details: {
            backupDir,
            output: stdout.trim(),
          },
        },
      });
    } catch (error) {
      this.logger.error(`Falha ao executar backup diario: ${(error as Error)?.message}`);
      await this.prisma.auditTrail.create({
        data: {
          actorType: ActorType.SYSTEM,
          action: 'system.backup.failure',
          details: {
            backupDir,
            error: (error as Error)?.message || 'unknown',
          },
        },
      });
    }
  }
}
