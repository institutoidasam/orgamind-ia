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
  Query,
  Res,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { ContactsService } from './contacts.service';
import { ContactsExportService } from './contacts-export.service';
import { ListContactsDto } from './dto/list-contacts.dto';
import { UpdateContactDto } from './dto/update-contact.dto';
import { CreateContactDto } from './dto/create-contact.dto';
import { BulkDeleteContactsDto } from './dto/bulk-delete-contacts.dto';
import { SetContactLabelsDto } from './dto/set-contact-labels.dto';
import { SyncContactsDto, SyncProgressDto } from './dto/sync-contacts.dto';
import { ExportContactsDto } from './dto/export-contacts.dto';
import { Roles } from '../auth/decorators/roles.decorator';

@ApiTags('contacts')
@Controller('contacts')
export class ContactsController {
  constructor(
    private readonly contacts: ContactsService,
    private readonly exportService: ContactsExportService,
  ) {}

  @ApiOperation({ summary: 'List contacts with filters/pagination' })
  @Get()
  list(@Query() q: ListContactsDto) {
    return this.contacts.list(q);
  }

  @ApiOperation({
    summary:
      'Distinct values + counts (facets) per filterable field, for the campaign filter UI',
  })
  @Get('facets')
  facets() {
    return this.contacts.facets();
  }

  @ApiOperation({ summary: 'Create a single contact (manual entry)' })
  @Post()
  create(@Body() body: CreateContactDto) {
    return this.contacts.create(body);
  }

  @ApiOperation({
    summary:
      'Progress of the active number validation — how many contacts were checked since `since` (ADMIN)',
  })
  @Roles('ADMIN')
  @Get('sync/progress')
  syncProgress(@Query() q: SyncProgressDto) {
    return this.contacts.syncProgress(new Date(q.since));
  }

  @ApiOperation({
    summary:
      'Export the filtered contact list as .xlsx (ADMIN) — same query params as GET /contacts',
  })
  @Roles('ADMIN')
  @Get('export.xlsx')
  async exportXlsx(
    @Query() q: ExportContactsDto,
    @Res() res: Response,
  ): Promise<void> {
    // `@Res()` sem `passthrough`: quem termina a resposta é o WorkbookWriter,
    // que escreve o ZIP direto no socket. É o mesmo idioma de
    // chat-media.controller.ts, e pelo mesmo motivo (o corpo não é JSON).
    await this.exportService.streamXlsx(q, res);
  }

  @ApiOperation({ summary: 'Export contact data (LGPD subject access)' })
  @Get(':id/export')
  export(@Param('id') id: string) {
    return this.contacts.exportData(id);
  }

  @ApiOperation({ summary: 'Update contact (e.g. opt-out, tags, attributes)' })
  @Patch(':id')
  update(@Param('id') id: string, @Body() body: UpdateContactDto) {
    return this.contacts.update(id, body);
  }

  @ApiOperation({
    summary:
      'Bulk delete contacts (admin) — by ids, all=true, or validity="invalid" ' +
      '(optionally with expectedCount, the count the operator confirmed on screen; ' +
      'returns 409 and deletes nothing if the live count no longer matches)',
  })
  @Roles('ADMIN')
  @Post('bulk-delete')
  bulkDelete(@Body() body: BulkDeleteContactsDto) {
    return this.contacts.bulkDelete(body);
  }

  @ApiOperation({
    summary:
      'Backfill contact WhatsApp sync — enqueues chunks for all or unvalidated contacts (ADMIN)',
  })
  @Roles('ADMIN')
  @Post('sync')
  @HttpCode(HttpStatus.OK)
  async syncBackfill(@Body() dto: SyncContactsDto) {
    return this.contacts.syncBackfill(dto.mode);
  }

  @ApiOperation({
    summary:
      'Set the full WhatsApp Business labels list for a contact — adds/removes via Evolution',
  })
  @Roles('ADMIN')
  @Post(':id/labels')
  setContactLabels(
    @Param('id') id: string,
    @Body() body: SetContactLabelsDto,
  ) {
    return this.contacts.setLabels(id, body.labelIds);
  }

  @ApiOperation({ summary: 'Delete contact (LGPD erasure) (ADMIN)' })
  @Roles('ADMIN')
  @Delete(':id')
  delete(@Param('id') id: string) {
    return this.contacts.delete(id);
  }
}
