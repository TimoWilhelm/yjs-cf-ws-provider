import { z } from 'zod';

function serializeError(error: Error | unknown): string {
  if (typeof error === 'string') return error;
  return JSON.stringify(error, Object.getOwnPropertyNames(error));
}

export async function handleWorkerErrors(
  request: Request,
  handler: () => Response | Promise<Response>,
) {
  try {
    return await Promise.resolve(handler());
  } catch (err) {
    console.error('Uncaught exception', err);
    if (request.headers.get('upgrade') === 'websocket') {
      // Annoyingly, if we return an HTTP error in response to a WebSocket request, Chrome devtools
      // won't show us the response body! So... let's send a WebSocket response with an error
      // frame instead.
      const pair = new WebSocketPair();
      pair[1].accept();
      pair[1].send(JSON.stringify({ error: serializeError(err) }));
      pair[1].close(1011, 'Uncaught exception during session setup');
      return new Response(null, { status: 101, webSocket: pair[0] });
    }

    return new Response(serializeError(err), { status: 500 });
  }
}

export const uuidV7 = uuidV7Builder((array) => crypto.getRandomValues(array));

export function uuidV7Builder(
  getRandomValues: (array: Uint32Array) => Uint32Array,
): () => `${string}-${string}-${string}-${string}-${string}` {
  const UNIX_TS_MS_BITS = 48;
  const VER_DIGIT = '7';
  const SEQ_BITS = 12;
  const VAR = 0b10;
  const VAR_BITS = 2;
  const RAND_BITS = 62;

  let prevTimestamp = -1;
  let seq = 0;

  return () => {
    // Negative system clock adjustments are ignored to keep monotonicity
    const timestamp = Math.max(Date.now(), prevTimestamp);
    seq = timestamp === prevTimestamp ? seq + 1 : 0;
    prevTimestamp = timestamp;

    const varRand = new Uint32Array(2);
    getRandomValues(varRand);
    // eslint-disable-next-line no-bitwise
    varRand[0] = (VAR << (32 - VAR_BITS)) | (varRand[0] >>> VAR_BITS);

    const digits =
      timestamp.toString(16).padStart(UNIX_TS_MS_BITS / 4, '0') +
      VER_DIGIT +
      seq.toString(16).padStart(SEQ_BITS / 4, '0') +
      varRand[0].toString(16).padStart((VAR_BITS + RAND_BITS) / 2 / 4, '0') +
      varRand[1].toString(16).padStart((VAR_BITS + RAND_BITS) / 2 / 4, '0');

    // prettier-ignore
    return `${digits.slice(0, 8)}-${digits.slice(8, 12)}-${digits.slice(12, 16)}-${digits.slice(16,20)}-${digits.slice(20)}`;
  };
}

export function* chunkArray<T>(arr: readonly T[], n: number) {
  for (let i = 0; i < arr.length; i += n) {
    yield arr.slice(i, i + n);
  }
}

export const coerceOptionalBooleanStrict = z
  .union([z.boolean().optional(), z.literal('true'), z.literal('1')])
  .catch(false)
  .transform((value) => (value === undefined ? undefined : Boolean(value)));

function safeParseJSON(string: string): unknown {
  try {
    return JSON.parse(string);
  } catch {
    return string;
  }
}

function searchParamsToValues(searchParams: URLSearchParams): Record<string, unknown> {
  return Array.from(searchParams.keys()).reduce((record, key) => {
    const values = searchParams.getAll(key).map(safeParseJSON);
    return { ...record, [key]: values.length > 1 ? values : values[0] };
  }, {} as Record<string, unknown>);
}

export function createSearchParamsObjSchema<Schema extends z.ZodObject<z.ZodRawShape>>(
  schema: Schema,
) {
  return z.instanceof(URLSearchParams).transform(searchParamsToValues).pipe(schema);
}

export function stringToColor(value: string) {
  let hash = 0;
  value.split('').forEach((char) => {
    hash = char.charCodeAt(0) + ((hash << 5) - hash);
  });
  let color = '#';
  for (let i = 0; i < 3; i++) {
    const value = (hash >> (i * 8)) & 0xff;
    color += value.toString(16).padStart(2, '0');
  }
  return color;
}
