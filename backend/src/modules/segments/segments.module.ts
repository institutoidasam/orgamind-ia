import { Module } from '@nestjs/common';
import { SegmentsService } from './segments.service';
import { SegmentsController } from './segments.controller';
import { SegmentsRepository } from './segments.repository';

@Module({
  controllers: [SegmentsController],
  providers: [SegmentsService, SegmentsRepository],
  exports: [SegmentsRepository],
})
export class SegmentsModule {}
