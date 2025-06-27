import { Market, Order } from "ccxt";
import { Exchange } from "../../../exchange";
import { ArbitrageOrder } from "../../compute/common";
import { OrderCatch } from "../catch";
import { cancelWithRetry, Step, syncOrder } from "../common";

export const rejectTimeout = <T>(ms: number): {
  promise: Promise<T>,
  timeout: NodeJS.Timeout
} => {
  let timeout: NodeJS.Timeout;
  const promise = new Promise<T>((_, reject) => timeout = setTimeout(reject, ms))
  return { timeout, promise }
}

export interface Result {
  futureOrder: Order,
  nextFuture?: {
    promise: Promise<any>,
    timeout: NodeJS.Timeout,
    entered: boolean
  },
  spotOrder: Order,
  nextSpot?: {
    promise: Promise<any>,
    timeout: NodeJS.Timeout,
    entered: boolean
  }
}

export const retryOrder = (
  key: 'futureOrder' | 'spotOrder',
  exchange: Exchange,
  result: Result,
  ordersCatch: OrderCatch,
  newPrice: number,
  market: Market,
  validOrder: (order: ArbitrageOrder, market: Market) => boolean,
  createOrder: (order: ArbitrageOrder, _?: number) => Promise<Order>
) => {
  const targetKey = key == 'futureOrder' ?
    'nextFuture' :
    'nextSpot'

  let resolver: (value: void | PromiseLike<void>) => void;
  const promise = new Promise<void>(resolve => resolver = resolve)

  result[targetKey] = {
    entered: false,
    promise,
    timeout: setTimeout(async () => {
      const target = result[targetKey]
      target.entered = true

      const { side, symbol } = result[key]
      const canceled = await cancelWithRetry(exchange, result[key])

      if (!canceled)
        return resolver()

      const current = ordersCatch.current()
      syncOrder([result[key]], current)

      if (result[key].remaining == 0)
        return resolver()

      let lastNonce = current.nonce

      while (!['canceled', 'closed', 'filled'].includes(result[key].status)) {
        const next = await ordersCatch.next(lastNonce + 1)
        syncOrder([result[key]], next)
        lastNonce = next.nonce

        /** If the cancelWithRetry doesnt really cancel */
        if (result[key].remaining == 0)
          return resolver()
      }

      const order: ArbitrageOrder = {
        price: newPrice,
        quantity: result[key].remaining
      }

      if (!validOrder(order, market))
        return resolver()

      try {
        result[key] = await createOrder(order)
        result[key].side = side
        result[key].symbol = symbol
      } catch (err) { }

      resolver()
    }, 3000)
  }
}

export enum VolatileDirection {
  Spot,
  Future
}

export const isVolatile = (
  step: Step,
  direction: VolatileDirection,
  lastPrice: number
): boolean => {
  const now = Date.now()

  const target = direction === VolatileDirection.Spot ? step.spot : step.future

  if (!target?.lastPrice)
    target!.lastPrice = [lastPrice, now]

  const [prevPrice, timestamp] = target!.lastPrice
  const timeDiff = now - timestamp
  const changed = prevPrice !== lastPrice

  if (changed)
    target!.lastPrice = [lastPrice, now]

  return changed || timeDiff < 3000
}