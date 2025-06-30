import { Order } from 'ccxt';
import { Exchange } from "../../../exchange";
import { doArbitrage } from '../../compute';
import { ArbitrageDirection } from "../../compute/common";
import { CancelOrderError } from '../cancel';
import { CatchReturn, OrderCatch } from '../catch';
import { ArbitrageNonce, createOrderValidator, prepareCreateOrder, Step, syncOrder } from '../common';
import { Entry } from '../run';
import { computeOrders, createOrderTracker, isVolatile, rejectTimeout, Result, VolatileDirection, waitTimeout } from './common';

interface ExitArbitrage {
  exchange: Exchange,
  symbol: string,
  entry: Entry,
  step: Step,
  arbitrageNonce: ArbitrageNonce,
  spotOrdersCatch: OrderCatch,
  futureOrdersCatch: OrderCatch,
  timeout: number,
  percent: number
}

export const runExitArbitrage = async ({
  exchange,
  symbol,
  entry,
  step,
  arbitrageNonce,
  spotOrdersCatch,
  futureOrdersCatch,
  timeout,
  percent
}: ExitArbitrage) => {
  if (step.executed)
    return

  if (!step.future?.result || !step.spot?.result)
    return

  if(step.lastOrder && !step.lastOrder?.finished)
    return

  const sameSpot = arbitrageNonce.spot == step.spot?.result?.nonce
  const sameFuture = arbitrageNonce.future == step.future?.result?.nonce

  if (sameFuture && sameSpot)
    return

  const manager = exchange.getManager()

  const validOrder = createOrderValidator(manager)

  const createSellSpotOrder = prepareCreateOrder(manager, symbol, 'sell')
  const createBuyFutureOrder = prepareCreateOrder(manager, `${symbol}:USDT`, 'buy', true)

  const [spotBook, futureBook] = [
    step.spot!.result!,
    step.future!.result!
  ]

  const spotMarket = manager.market(symbol)
  const futureMarket = manager.market(`${symbol}:USDT`)

  const exitArbitrage = doArbitrage({
    direction: ArbitrageDirection.Exit,
    spotBook: spotBook.bids,
    futureBook: futureBook.asks,
    executed: entry.quantity * 2,
    percent,
    contractSize: futureMarket.contractSize ?? 1
  })

  exitArbitrage.executed *= 0.7 // 30% less than the computed value;

  arbitrageNonce.spot = step.spot.result.nonce
  arbitrageNonce.future = step.future.result.nonce

  if (!exitArbitrage.spotOrders.length ||
    !exitArbitrage.futureOrders.length)
    return

  const isSpotVolatile = isVolatile(step, VolatileDirection.Spot, exitArbitrage.maxPrice.spot)
  let validSpot =
    exitArbitrage.spotOrders[0].price != exitArbitrage.maxPrice.spot ||
    !isSpotVolatile

  const isFutureVolatile = isVolatile(step, VolatileDirection.Future, exitArbitrage.maxPrice.future)
  let validFuture =
    exitArbitrage.futureOrders[0].price != exitArbitrage.maxPrice.future ||
    !isFutureVolatile

  if (!validFuture || !validSpot) {
    await waitTimeout(3000)

    validSpot = isVolatile(step, VolatileDirection.Spot, exitArbitrage.maxPrice.spot)
    validFuture = isVolatile(step, VolatileDirection.Future, exitArbitrage.maxPrice.future)

    if(validSpot)
      step.spot!.lastPrice[1] = Date.now()

    if(validFuture)
      step.future!.lastPrice[1] = Date.now()
  }

  if (!validFuture || !validSpot)
    return

  if (step.executed)
    return

  delete step.future.result
  delete step.spot.result

  const remainingQuantityForExit = Math.min(entry.quantity - entry.exited, entry.temp.entry)

  const { spotArbitrageOrder, futureArbitrageOrder, executed } = computeOrders(
    entry,
    exchange,
    remainingQuantityForExit,
    exitArbitrage,
    spotMarket,
    futureMarket,
    validOrder
  ) ?? {}

  if(!executed)
    return

  const tracker = createOrderTracker()
  step.lastOrder = tracker

  if (executed > entry.quantity - entry.temp.exit)
    return

  entry.temp.exit += executed

  const [spotOrder, futureOrder] = await Promise.allSettled([
    createSellSpotOrder(spotArbitrageOrder),
    createBuyFutureOrder(futureArbitrageOrder)
  ])

  tracker.resolve()

  const hasError =
    spotOrder.status === 'rejected' ||
    futureOrder.status === 'rejected'

  if (hasError)
    throw new CancelOrderError(
      spotOrder.status == 'fulfilled' ? spotOrder.value : null,
      futureOrder.status == 'fulfilled' ? futureOrder.value : null,
      'exit'
    )

  let finished = false,
    spotDone = false,
    futureDone = false;

  const time = rejectTimeout<[CatchReturn, CatchReturn]>(timeout)

  const result: Result = {
    futureOrder: futureOrder.value,
    spotOrder: spotOrder.value
  }

  result.spotOrder.side = 'sell'
  result.spotOrder.symbol = symbol

  result.futureOrder.side = 'buy'
  result.futureOrder.symbol = `${symbol}:USDT`

  const clearAndWait = async () => {
    clearTimeout(time.timeout)
    clearTimeout(result.nextSpot?.timeout)
    clearTimeout(result.nextFuture?.timeout)

    if (result.nextSpot?.entered)
      await result.nextSpot?.promise

    if (result.nextFuture?.entered)
      await result.nextFuture?.promise
  }

  const lastNonces = { spot: -1, future: -1 }

  while (!finished) {
    try {
      const done = (order: Order) =>
        order.remaining == 0

      const [spot, future] = await Promise.race([
        time.promise,
        Promise.all([
          !spotDone ? spotOrdersCatch.next(lastNonces.spot + 1) : [],
          !futureDone ? futureOrdersCatch.next(lastNonces.future + 1) : []
        ])
      ]) as [CatchReturn, CatchReturn]

      if (spot.nonce != undefined)
        lastNonces.spot = spot.nonce

      if (future.nonce != undefined)
        lastNonces.future = future.nonce

      syncOrder([result.spotOrder], spot)
      syncOrder([result.futureOrder], future)

      spotDone = done(result.spotOrder)
      futureDone = done(result.futureOrder)

      finished = spotDone && futureDone
    } catch (err) {
      await clearAndWait()

      throw new CancelOrderError(
        result.spotOrder,
        result.futureOrder,
        'exit'
      )
    }
  }

  await clearAndWait()

  return {
    spotOrder: result.spotOrder,
    futureOrder: result.futureOrder,
  }
}