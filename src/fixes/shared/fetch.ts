import {
  buildConnector,
  Client,
  BodyInit as UndiciBodyInit,
  Headers as UndiciHeaders,
  HeadersInit as UndiciHeadersInit,
  RequestInit as UndiciRequestInit,
  Response as UndiciResponse
} from 'undici';
import type Dispatcher from 'undici/types/dispatcher';
import { ciphers } from './ciphers';

export async function fetch(input: RequestInfo, init?: RequestInit): Promise<Response> {
  const connector = buildConnector({ ciphers: ciphers() })

  const url = typeof input == 'string' ? input : input.url

  const urlObj = new URL(url)

  const client = new Client(urlObj.origin, { connect: connector })

  let method = 'GET'
  let headers: UndiciHeadersInit = {}
  let body: UndiciBodyInit | null = null
  let signal: AbortSignal | null = null

  if (typeof input !== 'string') {
    method = input.method || method;
    headers = input.headers;
    body = input.body || null;
    signal = input.signal || null;
  }

  if (init) {
    method = init.method || method;
    if (init.headers) headers = init.headers;
    if (init.body !== undefined) body = (init as UndiciRequestInit).body;
    if (init.signal) signal = init.signal;
  }

  const path = urlObj.pathname + urlObj.search

  const res = await client.request({
    path,
    method: method as Dispatcher.HttpMethod,
    headers: new UndiciHeaders(headers),
    body: body as any,
    signal
  })

  const result = new UndiciResponse(res.body, res)
  const text = await result.text()
  await client.close()
  return responseWithText(result, text)
}

export const responseWithText = (response: Response | UndiciResponse, text: string): Response => {
  return new UndiciResponse(text, response) as any
}