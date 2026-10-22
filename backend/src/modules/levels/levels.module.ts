import { Module } from '@nestjs/common';
import { LevelsController } from './levels.controller';
import { LevelsRepository } from './levels.repository';
import { LevelsService } from './levels.service';

/** `LevelsRepository` é exportado: usuários, página do setor e envio leem `findById`/`listActive`. */
@Module({
  controllers: [LevelsController],
  providers: [LevelsRepository, LevelsService],
  exports: [LevelsRepository],
})
export class LevelsModule {}
