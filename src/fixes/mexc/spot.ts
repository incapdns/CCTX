import { browserHeaders } from "../shared/browserHeaders"
import { responseWithText } from "../shared/fetch"
import { getSymbols } from "../shared/symbols"

const spotUrl = 'https://api.mexc.com/api/v3/order'

export default function applyFix(url: string, params: RequestInit): [string, RequestInit, (response: Response) => Promise<Response>] {
  if (!url.includes(spotUrl))
    return [url, params, async res => res]

  const parsed = new URL(url)

  let newUrl;

  let body: any = {}

  const orderType = parsed.searchParams.get('type')
  switch (orderType) {
    case 'LIMIT':
      newUrl = 'https://www.mexc.com/api/platform/spot/order/place'
      body.orderType = 'LIMIT_ORDER'
      break;

    case 'MARKET':
      if(!parsed.searchParams.get('price'))
        parsed.searchParams.set('price', '10')
      
      newUrl = 'https://www.mexc.com/api/platform/spot/v4/order/place'
      body.orderType = 'MARKET_ORDER'
      break;

    default:
      return [url, params, async res => res]
  }

  const tradeType = parsed.searchParams.get('side')
  const price = parsed.searchParams.get('price')
  const quantity = parsed.searchParams.get('quantity')
  const symbol = parsed.searchParams.get('symbol')

  const symbols = getSymbols()
  const search = Object
    .entries(symbols)
    .find(([name]) => symbol.endsWith(name))

  if (!search)
    return [url, params, async res => res]

  const [name, marketCurrency] = search

  const currencyName = symbol
    .split(name)[0]
    .replace('/', '')

  const currency = marketCurrency.itens.get(currencyName)

  if (!currency)
    return [url, params, async res => res]

  body = {
    ...body,
    tradeType,
    price,
    quantity,
    marketCurrencyId: marketCurrency.id,
    currencyId: currency.id
  }

  if (params.headers) {
    delete params.headers['Content-Type']
    delete params.headers['Content-type']
    delete params.headers['content-type']

    delete params.headers['X-MEXC-APIKEY']
    delete params.headers['source']
  }

  params.headers = {
    ...params.headers,
    ...browserHeaders
  }

  params = {
    ...params,
    method: 'POST'
  }

  params.body = JSON.stringify(body)

  return [
    newUrl,
    params,
    async response => {
      const text = await response.text()

      try {
        const json = JSON.parse(text)

        return responseWithText(response, JSON.stringify({
          ...json,
          ...json?.data && {
            id: json.data,
            code: undefined
          }
        }))
      } catch (err) {
        return responseWithText(response, text)
      }
    }
  ]
}