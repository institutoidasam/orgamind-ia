import { Module } from '@nestjs/common';
import { InternalCommunicationsController } from './internal-communications.controller';
import { InternalCommunicationsService } from './internal-communications.service';

@Module({
  controllers: [InternalCommunicationsController],
  providers: [InternalCommunicationsService],
  exports: [InternalCommunicationsService],
})
export class InternalCommunicationsModule {}
