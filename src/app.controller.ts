import { Controller, Get, Head } from '@nestjs/common';
import { Public } from './common/decorators/public.decorator';

@Controller()
export class AppController {
  @Public()
  @Get()
  root() {
    return {
      ok: true,
      service: 'next-level-backend',
      timestamp: new Date().toISOString(),
    };
  }

  @Public()
  @Head()
  rootHead() {
    return;
  }
}
