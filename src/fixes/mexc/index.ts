import { pro as ccxt, mexc } from 'ccxt';
import crypto from 'crypto';
import futureFix from './future';
import spotFix from './spot';
import { fetch } from '../shared/fetch';

export const prepareFix = () => {
  const describe = ccxt.mexc.prototype.describe

  ccxt.mexc.prototype.describe = function () {
    const result = describe.call(this)
    result.has.future = true
    return result
  }
}

const fixes = [spotFix, futureFix]

const applyFix = (url: string, params: RequestInit): [string, RequestInit, (response: Response) => Promise<Response>] => {
  const modifiers: Array<(response: Response) => Promise<Response>> = []

  const result: [string, RequestInit] =
    fixes.reduce((previous, current) => {
      const result = current(previous[0], previous[1])
      modifiers.push(result[2])
      return [result[0], result[1]]
    }, [url, params])

  return [
    result[0],
    result[1],
    async response => {
      let result = response

      for(const modifier of modifiers)
        result = await modifier(result)

      return result
    }
  ]
}

let counter = 0;

export const fixMexc = (mexc: mexc, authorization: string): mexc => {
  mexc.AbortError = DOMException
  mexc.FetchError = TypeError
  mexc.fetchImplementation = (defaultUrl: string, defaultParams: RequestInit) => {
    const [url, params, modifier] = applyFix(defaultUrl, defaultParams)

    if (params.method.toUpperCase() == 'POST') {
      const nonce = (Date.now() + ++counter).toString()

      const secret = crypto
        .createHash('md5')
        .update(`${authorization}${nonce}`)
        .digest('hex')
        .substring(7)

      const sign = crypto
        .createHash('md5')
        .update(`${nonce}${params.body}${secret}`)
        .digest('hex')

      params.headers = {
        ...params.headers,
        'x-mxc-nonce': nonce,
        'x-mxc-sign': sign,
        authorization,
        cookie: `u_id=${authorization};`
      }
    }
    
    return fetch(url, params)
      .then(modifier)
  }

  return mexc
}