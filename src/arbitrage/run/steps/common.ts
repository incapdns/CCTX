import { Exchange as CcxtExchange, Market, Order } from "ccxt";
import { Exchange } from "../../../exchange";
import { ArbitrageDirection, ArbitrageOrder, ArbitrageResult } from "../../compute/common";
import { OrderCatch } from "../catch";
import { cancelWithRetry, Step, syncOrder } from "../common";
import { Entry } from "../run";

export const rejectTimeout = <T>(ms: number): {
  promise: Promise<T>,
  timeout: NodeJS.Timeout
} => {
  let timeout: NodeJS.Timeout;
  const promise = new Promise<T>((_, reject) => timeout = setTimeout(reject, ms))
  return { timeout, promise }
}

export const waitTimeout = (ms: number): Promise<void> => 
  new Promise(resolve => setTimeout(resolve, ms))

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
        quantity: result[key].remaining,
      }

      if (!validOrder(order, market))
        return resolver()

      try {
        const previous = result[key]
        result[key] = await createOrder(order)
        result[key].side = side
        result[key].symbol = symbol
        result[key].info = { previous }
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

export const computeCommonQuantity = (
  exchange: CcxtExchange,
  executed: number,
  spotMarket: Market,
  futureMarket: Market
): number => {
  try {
    const contractSize = futureMarket.contractSize ?? 1

    const spotMin =
      spotMarket.limits?.amount?.min ??
      spotMarket.precision?.amount ??
      0

    const futureMinContracts =
      futureMarket.limits?.amount?.min ??
      futureMarket.precision?.amount ??
      1
    const futureMin = futureMinContracts * contractSize

    const spotInit = Number(
      exchange.amountToPrecision(spotMarket.symbol, executed)
    )
    const futureInit =
      Number(
        exchange.amountToPrecision(
          futureMarket.symbol,
          executed / contractSize
        )
      ) * contractSize

    let qty = Math.max(spotInit, futureInit, spotMin, futureMin)
    let prev = -1
    let iter = 0
    const MAX_ITER = 10

    while (qty !== prev && iter < MAX_ITER) {
      prev = qty

      const fut =
        Number(
          exchange.amountToPrecision(
            futureMarket.symbol,
            qty / contractSize
          )
        ) * contractSize

      qty = Number(
        exchange.amountToPrecision(
          spotMarket.symbol,
          fut
        )
      )

      qty = Math.max(qty, spotMin, futureMin)

      iter++
    }

    if (iter === MAX_ITER) {
      console.warn(
        '[computeCommonQuantity] atingiu máximo de iterações; ' +
        'valor pode não ter convergido perfeitamente'
      )
    }

    return qty
  } catch (err) {
    return -1
  }
}

export type MaybeOrders = {
  spotArbitrageOrder: ArbitrageOrder
  futureArbitrageOrder: ArbitrageOrder,
  executed: number
} | null

export const computeOrders = (
  entry: Entry,
  exchange: Exchange,
  limit: number,
  arbitrage:
    | ArbitrageResult<ArbitrageDirection.Entry>
    | ArbitrageResult<ArbitrageDirection.Exit>,
  spotMarket: Market,
  futureMarket: Market,
  validOrder: (order: ArbitrageOrder, market: Market) => boolean
): MaybeOrders => {
  const manager = exchange.getManager()

  const spotMinQty     = spotMarket.limits?.amount?.min ?? 0
  const contractSize   = futureMarket.contractSize ?? 1
  const futureMinQty   = (futureMarket.limits?.amount?.min ?? 0) * contractSize

  const spotMinCost    = spotMarket.limits?.cost?.min ?? 0
  const futureMinCost  = futureMarket.limits?.cost?.min ?? 0

  const COST_BUFFER    = 1.02

  let executed = Math.min(arbitrage.executed, limit)

  for (let i = 0; i < 10; i++) {
    executed = computeCommonQuantity(
      manager,
      executed,
      spotMarket,
      futureMarket
    )
    if (executed <= 0) return null

    const nextRemaining = entry.remainingQuantity - executed

    const diffQtySpot   = spotMinQty   - nextRemaining
    const diffQtyFuture = futureMinQty - nextRemaining

    const reqQtyByCostSpot = (spotMinCost * COST_BUFFER)  / arbitrage.maxPrice.spot
    const reqQtyByCostFut  = (futureMinCost * COST_BUFFER) / arbitrage.maxPrice.future

    const diffCostSpot   = reqQtyByCostSpot   - nextRemaining
    const diffCostFuture = reqQtyByCostFut    - nextRemaining

    if (nextRemaining > 0 && (
      diffQtySpot   > 0 ||
      diffQtyFuture > 0 ||
      diffCostSpot  > 0 ||
      diffCostFuture> 0
    )) {
      const maxGap = Math.max(
        diffQtySpot,
        diffQtyFuture,
        diffCostSpot,
        diffCostFuture
      )
      executed -= maxGap
      continue
    }

    const spotOrder: ArbitrageOrder = {
      price:    arbitrage.maxPrice.spot,
      quantity: executed
    }
    if (!validOrder(spotOrder, spotMarket))  continue

    const futureOrder: ArbitrageOrder = {
      price:    arbitrage.maxPrice.future,
      quantity: executed
    }
    if (!validOrder(futureOrder, futureMarket)) continue

    return {
      spotArbitrageOrder: spotOrder,
      futureArbitrageOrder: futureOrder,
      executed
    }
  }

  return null
}

export const createOrderTracker = () => {
  let resolver: (value: void | PromiseLike<void>) => void;
  const promise = new Promise<void>(resolve => resolver = resolve);

  return {
    promise,
    finished: false,
    resolve: function () {
      this.finished = true
      resolver()
    }
  }
}