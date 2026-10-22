import { Module } from '@nestjs/common';
import { LevelsModule } from '../levels/levels.module';
import { ShiftsRepository } from '../shifts/shifts.repository';
import { UsersModule } from '../users/users.module';
import { SectorPeopleController } from './sector-people.controller';
import { SectorPeopleRepository } from './sector-people.repository';
import { SectorPeopleService } from './sector-people.service';
import { SectorPeopleWriteService } from './sector-people-write.service';

/**
 * Página do setor (C3/P1). `LevelsModule` exporta `listActive`; o
 * `ShiftsModule` não exporta o repositório, que é registrado aqui (sem estado,
 * só `PrismaService`, que é global). `UsersModule` exporta o `UsersService`,
 * pelo qual a escrita grava (D12).
 */
@Module({
  imports: [LevelsModule, UsersModule],
  controllers: [SectorPeopleController],
  providers: [
    SectorPeopleRepository,
    SectorPeopleService,
    SectorPeopleWriteService,
    ShiftsRepository,
  ],
})
export class SectorPeopleModule {}
