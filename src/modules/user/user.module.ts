import { Module } from '@nestjs/common';
import { UserController } from './user.controller';
import { UserService } from './user.service';
import { ProfileController } from './profile.controller';

@Module({
  controllers: [UserController, ProfileController],
  providers: [UserService],
})
export class UserModule {}
