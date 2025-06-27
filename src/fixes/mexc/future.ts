import { responseWithText } from "../shared/fetch"

const futureUrl = 'https://contract.mexc.com/api/v1/private/order/submit'
const newUrl = 'https://futures.mexc.com/api/v1/private/order/create'

export default function applyFix(url: string, params: RequestInit): [string, RequestInit, (res: Response) => Promise<Response>] {
  if (!url.includes(futureUrl))
    return [url, params, async res => res]

  params.headers = { ...params.headers }

  delete params.headers['X-MEXC-APIKEY']
  delete params.headers['source']

  return [
    newUrl,
    params,
    async response => {
      const text = await response.text()

      try {
        const json = JSON.parse(text)
        const id = json?.data?.orderId ?? json?.orderId

        return responseWithText(response, JSON.stringify({
          ...json,
          ...id && {
            ...json.data,
            data: id,
            code: undefined
          }
        }))
      } catch (err) {
        return responseWithText(response, text)
      }
    }
  ]
}