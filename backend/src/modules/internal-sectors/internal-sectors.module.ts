import { Module } from '@nestjs/common';
import { InternalSectorsController } from './internal-sectors.controller';
import { InternalSectorsRepository } from './internal-sectors.repository';
import { InternalSectorsService } from './internal-sectors.service';
@Module({
  controllers: [InternalSectorsController],
  providers: [InternalSectorsRepository, InternalSectorsService],
  exports: [InternalSectorsRepository],
})
export class InternalSectorsModule {}
