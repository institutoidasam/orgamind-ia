/**
 * Colunas da ficha que o USER_SUMMARY_SELECT devolve para quem nunca teve
 * matrícula nem autorização registrada. Espalhe nos fixtures de `UserSummary`.
 */
export const NO_PERSON_RECORD = {
  registration: null,
  contactAuthorization: 'NAO_AUTORIZADO',
  authorizationSource: null,
  authorizationNote: null,
  authorizationDate: null,
  authorizationRecordedAt: null,
} as const;
