import { describe, it, expect } from 'vitest';
import { Prisma, MessageDirection, MessageKind, MediaStatus, MessageStatus } from '@prisma/client';

describe('chat schema additions', () => {
  it('exposes new enums', () => {
    expect(MessageDirection.INBOUND).toBe('INBOUND');
    expect(MessageDirection.OUTBOUND).toBe('OUTBOUND');
    expect(MessageKind.IMAGE).toBe('IMAGE');
    expect(MediaStatus.PENDING).toBe('PENDING');
    expect(MessageStatus.RECEIVED).toBe('RECEIVED');
  });

  it('Conversation + MessageMedia models exist in the Prisma client', () => {
    expect(Prisma.ModelName.Conversation).toBe('Conversation');
    expect(Prisma.ModelName.MessageMedia).toBe('MessageMedia');
  });
});
