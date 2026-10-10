import { Module } from '@nestjs/common';
import { PrismaModule } from '../../shared/prisma/prisma.module';
import { InternalNumbersController } from './internal-numbers.controller';
import { InternalNumbersService } from './internal-numbers.service';

@Module({
  imports: [PrismaModule],
  controllers: [InternalNumbersController],
  providers: [InternalNumbersService],
})
export class InternalNumbersModule {}
