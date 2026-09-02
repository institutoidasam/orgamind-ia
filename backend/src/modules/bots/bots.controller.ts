import { Body, Controller, Get, Patch } from '@nestjs/common';
import { BotsService } from './bots.service';
import { Roles } from '../auth/decorators/roles.decorator';
import { AssignBotDto } from './dto/assign-bot.dto';

@Controller('bots')
export class BotsController {
  constructor(private readonly svc: BotsService) {}

  @Roles('ADMIN')
  @Get('dify-apps')
  difyApps() {
    return this.svc.listDifyChatApps();
  }

  @Roles('ADMIN')
  @Patch('assignment')
  assign(@Body() body: AssignBotDto) {
    return this.svc.assignBotToInstance(body.instanceId, body.difyAppId);
  }
}
