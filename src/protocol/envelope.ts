import { isNat, isRecord } from './guards.ts';
import {
  checkError,
  checkRequestBody,
  checkResult,
  type ProtocolError,
  type RequestBody,
  type RequestType,
  type ResponseBody,
  type Results,
} from './messages.ts';

// Конверт §6.1: { v, id, body }. id связывает запрос с ответом; у повтора запроса id новый, тело то же.
// Ответ на запрос, id которого не прочесть, несёт id: null.

export const PROTOCOL_VERSION = 1;

export interface RequestEnvelope {
  readonly v: typeof PROTOCOL_VERSION;
  readonly id: number;
  readonly body: RequestBody;
}

export interface ResponseEnvelope<T = unknown> {
  readonly v: typeof PROTOCOL_VERSION;
  readonly id: number | null;
  readonly body: ResponseBody<T>;
}

export function requestEnvelope(id: number, body: RequestBody): RequestEnvelope {
  return { v: PROTOCOL_VERSION, id, body };
}

export function responseEnvelope<T>(id: number | null, body: ResponseBody<T>): ResponseEnvelope<T> {
  return { v: PROTOCOL_VERSION, id, body };
}

export type ParsedRequest =
  | { readonly ok: true; readonly id: number; readonly body: RequestBody }
  | { readonly ok: false; readonly id: number | null; readonly error: ProtocolError };

/** Сервер: конверт и тело входящего запроса. Не бросает. */
export function parseRequest(raw: unknown): ParsedRequest {
  if (!isRecord(raw)) return { ok: false, id: null, error: { code: 'BAD_REQUEST', message: 'конверт — не объект' } };
  const id = isNat(raw['id']) ? raw['id'] : null;
  const v = raw['v'];
  if (!isNat(v)) return { ok: false, id, error: { code: 'BAD_REQUEST', message: 'v конверта — не целое' } };
  if (v !== PROTOCOL_VERSION) return { ok: false, id, error: { code: 'VERSION_MISMATCH', supported: PROTOCOL_VERSION } };
  if (id === null) return { ok: false, id, error: { code: 'BAD_REQUEST', message: 'id конверта — не целое' } };
  const body = raw['body'];
  const problem = checkRequestBody(body);
  if (problem !== null) return { ok: false, id, error: { code: 'BAD_REQUEST', message: problem } };
  return { ok: true, id, body: body as RequestBody };
}

export type ParsedResponse<T extends RequestType> =
  | { readonly kind: 'result'; readonly id: number; readonly result: Results[T] }
  | { readonly kind: 'error'; readonly id: number | null; readonly error: ProtocolError }
  /** Сервер другой версии: клиенту остаётся предложить перезагрузку. */
  | { readonly kind: 'version'; readonly v: number }
  /** Ответ не прошёл гард — в том числе испорченные события раунда. */
  | { readonly kind: 'invalid'; readonly problem: string };

/** Клиент: конверт ответа и результат под тип отправленного запроса, с гардом событий раунда. Не бросает. */
export function parseResponse<T extends RequestType>(type: T, raw: unknown): ParsedResponse<T> {
  if (!isRecord(raw)) return { kind: 'invalid', problem: 'конверт — не объект' };
  const v = raw['v'];
  if (!isNat(v)) return { kind: 'invalid', problem: 'v конверта — не целое' };
  if (v !== PROTOCOL_VERSION) return { kind: 'version', v };
  const id = raw['id'];
  if (id !== null && !isNat(id)) return { kind: 'invalid', problem: 'id конверта — не целое' };
  const body = raw['body'];
  if (!isRecord(body)) return { kind: 'invalid', problem: 'тело ответа — не объект' };
  if (body['ok'] === true) {
    if (id === null) return { kind: 'invalid', problem: 'результат без id' };
    const problem = checkResult(type, body['result']);
    return problem === null ? { kind: 'result', id, result: body['result'] as Results[T] } : { kind: 'invalid', problem };
  }
  if (body['ok'] === false) {
    const problem = checkError(body['error']);
    return problem === null ? { kind: 'error', id, error: body['error'] as ProtocolError } : { kind: 'invalid', problem };
  }
  return { kind: 'invalid', problem: 'ok ответа — не булево' };
}
