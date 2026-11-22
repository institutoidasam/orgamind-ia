import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TeamAudienceRequest } from './dto/create-team-dispatch.dto';
import { ALERT_CONFIRM_SUFFIX } from './team-alert.rules';
import {
  REFERENCE_DATE,
  noticeAt,
  seedPerson,
  seedWorld,
  startRecheckDeps,
  type RecheckDeps,
  type World,
} from './team-whatsapp.schedule-recheck.test-fixtures';

/**
 * Aceite 13 (back), base de 6 e 16 (I2, I3; DI3, DI4), banco real: a Urgência
 * grava o texto com a linha fixa e o prazo de ciência; as outras finalidades e
 * o alvo pessoa gravam como antes. Porta ao vivo falsa (todo número aberto) e
 * fila falsa: nenhum WhatsApp de verdade.
 */
const LINE = 'Responda OK para confirmar que recebeu.';

let deps: RecheckDeps;
let stop: () => Promise<void>;

beforeAll(async () => {
  ({ deps, stop } = await startRecheckDeps());
}, 180_000);

afterAll(async () => {
  await stop?.();
});

async function worldWithPerson(): Promise<World> {
  const world = await seedWorld(deps);
  await seedPerson(deps, world, 'Ana');
  return world;
}

const urgencyOf = (
  world: World,
  text: string,
  over: Partial<TeamAudienceRequest> = {},
): TeamAudienceRequest =>
  noticeAt(world, {
    purpose: 'urgency',
    when: 'now',
    at: undefined,
    urgencyReason: 'Vazamento no galpão',
    text,
    ...over,
  });

/** Pelo caminho da tela: prévia e envio com a impressão que ela devolveu. */
async function sendUrgency(world: World, text: string): Promise<string> {
  const request = urgencyOf(world, text);
  const shown = await deps.audience.preview(world.adminId, request);
  const created = await deps.service.dispatch(world.adminId, {
    ...request,
    audienceKey: shown.audienceKey,
  });
  return created.dispatchId;
}

const storedOf = (dispatchId: string) =>
  deps.prisma.teamWhatsappDispatch.findUniqueOrThrow({
    where: { id: dispatchId },
    select: { text: true, ackDeadlineMinutes: true },
  });

describe('criação do alerta urgente — texto e prazo (aceite 13)', () => {
  it('aceite 13: texto gravado do alerta termina com linha em branco e a linha fixa', async () => {
    const world = await worldWithPerson();
    // Sem aparar: os espaços do fim e a quebra de linha ficam antes da linha fixa.
    const typed = 'Vazamento no galpão  \n';

    const stored = await storedOf(await sendUrgency(world, typed));

    expect(stored.text).toBe(`${typed}\n\n${LINE}`);
    expect(stored.text).toBe(typed + ALERT_CONFIRM_SUFFIX);
  });

  it('aceite 13: texto de 1959 caracteres grava 2000 com a linha', async () => {
    const world = await worldWithPerson();

    const stored = await storedOf(await sendUrgency(world, 'x'.repeat(1959)));

    expect(stored.text).toHaveLength(2000);
    expect(stored.text.endsWith(`\n\n${LINE}`)).toBe(true);
  });

  it('alerta grava ackDeadlineMinutes 15; reunião grava null', async () => {
    const world = await worldWithPerson();
    const meeting = noticeAt(world, {
      purpose: 'meeting',
      when: 'now',
      at: undefined,
      activity: { date: REFERENCE_DATE, time: '15:00', place: 'Sala 2' },
    });
    const shown = await deps.audience.preview(world.adminId, meeting);

    const sent = await deps.service.dispatch(world.adminId, {
      ...meeting,
      audienceKey: shown.audienceKey,
    });

    expect(
      (await storedOf(await sendUrgency(world, 'Alerta'))).ackDeadlineMinutes,
    ).toBe(15);
    expect(await storedOf(sent.dispatchId)).toEqual({
      text: meeting.text,
      ackDeadlineMinutes: null,
    });
  });
});

describe('criação do alerta urgente — alvo pessoa (DI4)', () => {
  it('envio a uma pessoa não tem finalidade: texto como enviado e prazo null', async () => {
    const world = await seedWorld(deps);
    const ana = await seedPerson(deps, world, 'Ana');

    const sent = await deps.service.dispatch(world.adminId, {
      text: 'Oi, Ana',
      target: { type: 'user', userId: ana.id },
    });

    expect(await storedOf(sent.dispatchId)).toEqual({
      text: 'Oi, Ana',
      ackDeadlineMinutes: null,
    });
  });
});

describe('criação do alerta urgente — travas e prévia (aceite 13, base de 6 e 16)', () => {
  it('texto vazio na Urgência continua 422 empty_text', async () => {
    const world = await worldWithPerson();
    const shown = await deps.audience.preview(
      world.adminId,
      urgencyOf(world, 'Alerta'),
    );

    for (const text of ['', '   \n ']) {
      await expect(
        deps.service.dispatch(world.adminId, {
          ...urgencyOf(world, text),
          audienceKey: shown.audienceKey,
        }),
      ).rejects.toMatchObject({
        status: 422,
        code: 'team_whatsapp.empty_text',
      });
    }
    expect(
      await deps.prisma.teamWhatsappDispatch.count({
        where: { authorId: world.adminId },
      }),
    ).toBe(0);
  });

  it('prévia da Urgência não muda (mesma impressão)', async () => {
    const world = await worldWithPerson();
    const short = await deps.audience.preview(
      world.adminId,
      urgencyOf(world, 'Alerta'),
    );

    // A impressão não cobre o texto: a prévia de 2000 caracteres é a mesma e
    // a criação com o texto de outra prévia passa.
    const long = await deps.audience.preview(
      world.adminId,
      urgencyOf(world, 'y'.repeat(2000)),
    );
    const created = await deps.service.dispatch(world.adminId, {
      ...urgencyOf(world, 'Outro texto'),
      audienceKey: short.audienceKey,
    });

    expect(long).toEqual(short);
    expect((await storedOf(created.dispatchId)).text).toBe(
      `Outro texto${ALERT_CONFIRM_SUFFIX}`,
    );
  });
});
