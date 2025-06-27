import { Order } from 'ccxt';
import { Exchange } from "../../exchange";

export type CatchReturn = Order[] & { nonce: number }

export interface OrderCatch {
  current(): CatchReturn
  next(nonce?: number): Promise<CatchReturn>
  unsubscribe: () => void
}

export const catchOrders = (exchange: Exchange, symbol: string): OrderCatch => {
  let resolver: (value: Order[] | PromiseLike<Order[]>) => void
  const current = {
    promise: new Promise<CatchReturn>(resolve => resolver = resolve),
    nonce: 0
  }

  const allResults: { [key: number]: CatchReturn } = {}

  let nextNonce = 0

  const orderCatch: OrderCatch = {
    async next(nonce = nextNonce) {
      const result = [] as CatchReturn
      let lastNonce = 0

      while (allResults[nonce]) {
        const savedResult = allResults[nonce]

        for (const order of savedResult) {
          const index = result.findIndex(o => o.id == order.id)
          if (index == -1)
            result.push(order)
          else
            result.splice(index, 1, order)
        }

        lastNonce = savedResult.nonce
        nonce++
      }

      if (result.length == 0) {
        const result = await current.promise
        nextNonce = result.nonce + 1
        return result
      }

      nextNonce = lastNonce + 1

      result.nonce = lastNonce

      return result
    },
    current() {
      let nonce = 0

      const result = [] as CatchReturn
      let lastNonce = 0

      while (allResults[nonce]) {
        const savedResult = allResults[nonce]

        for (const order of savedResult) {
          const index = result.findIndex(o => o.id == order.id)
          if (index == -1)
            result.push(order)
          else
            result.splice(index, 1, order)
        }

        lastNonce = savedResult.nonce

        nonce++
      }

      result.nonce = lastNonce

      return result
    },
    unsubscribe: () =>
      exchange.off(`orderOfSymbol:${symbol}`, callback)
  }

  const callback = (orders: Order[]) => {
    const currentNonce = current.nonce
    const result = orders as CatchReturn
    result.nonce = current.nonce++
    allResults[currentNonce] = result
    let previousResolver = resolver
    current.promise = new Promise<CatchReturn>(resolve => resolver = resolve)
    previousResolver(result)
  }

  exchange.on(`orderOfSymbol:${symbol}`, callback)

  return orderCatch
}