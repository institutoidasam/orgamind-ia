import { Body, Controller, Get, Param, Post, Req, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Request, Response } from 'express';
import { ChatMediaService } from './chat-media.service';
import { ValidationError } from '../../shared/errors/domain.error';

type AuthedRequest = Request & { user: { sub: string } };

// Only these (renderable, script-free) types are served `inline` with their
// real Content-Type. Everything else is forced to an opaque
// `application/octet-stream` + `attachment` download. This matters because an
// inbound media's mimeType is SENDER-controlled (it comes from Evolution/the
// WhatsApp sender): a crafted text/html or image/svg+xml served inline from
// our origin would otherwise be a stored-XSS vector when opened directly.
const INLINE_SAFE_MIME = new Set([
  'image/jpeg', 'image/png', 'image/webp', 'image/gif',
  'audio/ogg', 'audio/mpeg', 'audio/mp4', 'audio/aac',
  'video/mp4', 'video/webm', 'video/quicktime',
]);

@Controller('chat')
export class ChatMediaController {
  constructor(private readonly svc: ChatMediaService) {}

  @Get('media/:id')
  async serve(@Param('id') id: string, @Res() res: Response): Promise<void> {
    const { stream, mimeType, fileName } = await this.svc.getReadyMedia(id);
    // Strip params (e.g. "audio/ogg; codecs=opus") before the allowlist check.
    const baseMime = mimeType.split(';')[0].trim().toLowerCase();
    const safe = INLINE_SAFE_MIME.has(baseMime);
    const namePart = fileName ? `; filename="${encodeURIComponent(fileName)}"` : '';
    // nosniff stops the browser from MIME-sniffing octet-stream back into html.
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, max-age=86400');
    if (safe) {
      res.setHeader('Content-Type', mimeType);
      res.setHeader('Content-Disposition', `inline${namePart}`);
    } else {
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Disposition', `attachment${namePart}`);
    }
    stream.on('error', () => {
      if (!res.headersSent) res.status(404).end();
      else res.destroy();
    });
    stream.pipe(res);
  }

  @Post('conversations/:id/media')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 16 * 1024 * 1024 } }))
  sendMedia(@Param('id') id: string, @UploadedFile() file: Express.Multer.File, @Body('caption') caption: string | undefined, @Req() req: AuthedRequest) {
    if (!file) throw new ValidationError('Arquivo é obrigatório', undefined, 'media.file_required');
    return this.svc.sendMediaReply(id, req.user.sub, file, caption);
  }
}
