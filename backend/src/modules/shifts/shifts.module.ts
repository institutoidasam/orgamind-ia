import { Module } from '@nestjs/common';
import { ShiftsController } from './shifts.controller';
import { ShiftsRepository } from './shifts.repository';
import { ShiftsService } from './shifts.service';

@Module({
  controllers: [ShiftsController],
  providers: [ShiftsRepository, ShiftsService],
})
export class ShiftsModule {}
