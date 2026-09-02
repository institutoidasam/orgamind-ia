import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Req,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { SegmentsService } from './segments.service';
import { CreateSegmentDto } from './dto/create-segment.dto';
import { UpdateSegmentDto } from './dto/update-segment.dto';
import type { JwtPayload } from '../auth/jwt.strategy';

type AuthRequest = { user: JwtPayload };

@ApiTags('segments')
@Controller('segments')
export class SegmentsController {
  constructor(private readonly segments: SegmentsService) {}

  @ApiOperation({ summary: 'List segment summaries ordered by creation date' })
  @Get()
  list() {
    return this.segments.list();
  }

  @ApiOperation({ summary: 'Create a saved dynamic segment' })
  @Post()
  create(@Body() dto: CreateSegmentDto, @Req() req: AuthRequest) {
    return this.segments.create(dto, req.user.sub);
  }

  @ApiOperation({ summary: 'Fetch a segment with its filters' })
  @Get(':id')
  get(@Param('id') id: string) {
    return this.segments.getById(id);
  }

  @ApiOperation({ summary: 'Update a segment (name, description, filters)' })
  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateSegmentDto) {
    return this.segments.update(id, dto);
  }

  @ApiOperation({ summary: 'Delete a segment' })
  @HttpCode(HttpStatus.NO_CONTENT)
  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.segments.remove(id);
  }

  @ApiOperation({
    summary: 'Preview the segment audience: precise count + 10-row sample (caches count)',
  })
  @Get(':id/preview')
  preview(@Param('id') id: string) {
    return this.segments.preview(id);
  }

  @ApiOperation({
    summary: 'WhatsApp reachability summary for the segment audience (cached, no live scan)',
  })
  @Get(':id/preflight')
  preflight(@Param('id') id: string) {
    return this.segments.preflight(id);
  }
}
