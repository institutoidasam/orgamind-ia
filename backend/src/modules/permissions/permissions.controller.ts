import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Put,
  Req,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Roles } from '../auth/decorators/roles.decorator';
import type { JwtPayload } from '../auth/jwt.strategy';
import { SavePermissionMatrixDto } from './dto/save-permission-matrix.dto';
import { PermissionsService } from './permissions.service';

type AuthRequest = { user: JwtPayload };

/**
 * Matriz de permissões por ação. "Definir permissões" é regra fixa do ADMIN
 * (`@Roles` na classe, não `@RequirePermission`): a tela nunca fica sem dono.
 */
@ApiTags('permissions')
@Roles('ADMIN')
@Controller('permissions')
export class PermissionsController {
  constructor(private readonly permissions: PermissionsService) {}

  @Get()
  @ApiOperation({ summary: 'Matriz de permissões dos quatro papéis' })
  matrix() {
    return this.permissions.matrix();
  }

  @Put()
  @ApiOperation({
    summary: 'Grava o estado completo de SUPERVISOR e OPERATOR, com trilha',
  })
  save(@Body() dto: SavePermissionMatrixDto, @Req() req: AuthRequest) {
    return this.permissions.save(req.user.sub, dto);
  }

  @Post('restore-defaults')
  @HttpCode(200)
  @ApiOperation({ summary: 'Restaura a matriz inicial, com trilha' })
  restoreDefaults(@Req() req: AuthRequest) {
    return this.permissions.restoreDefaults(req.user.sub);
  }
}
