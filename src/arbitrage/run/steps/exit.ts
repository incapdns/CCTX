import { Order } from 'ccxt';
import Decimal from 'decimal.js';
import { Exchange } from "../../../exchange";
import { doArbitrage } from '../../compute';
import { ArbitrageDirection } from "../../compute/common";
import { isOutsideTolerance } from '../../compute/entry';
import { CancelOrderError } from '../cancel';
import { CatchReturn, OrderCatch } from '../catch';
import { ArbitrageNonce, createOrderValidator, prepareCreateOrder, Step, syncOrder } from '../common';
import { Entry } from '../run';
import { computeOrders, isVolatile, rejectTimeout, Result, retryOrder, VolatileDirection } from './common';

interface exitArbitrage {
  exchange: Exchange,
  symbol: string,
  entry: Entry,
  step: Step,
  arbitrageNonce: ArbitrageNonce,
  spotOrdersCatch: OrderCatch,
  futureOrdersCatch: OrderCatch,
  timeout: number
}

const percent = 0

export const runExitArbitrage = async ({
  exchange,
  symbol,
  entry,
  step,
  arbitrageNonce,
  spotOrdersCatch,
  futureOrdersCatch,
  timeout
}: exitArbitrage) => {
  if (step.executed)
    return

  if (!step.future?.result || !step.spot?.result)
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
    spotBook: spotBook.asks,
    futureBook: futureBook.bids,
    executed: entry.executed,
    percent
  })

  arbitrageNonce.spot = step.spot.result.nonce
  arbitrageNonce.future = step.future.result.nonce

  if (!exitArbitrage.spotOrders.length ||
    !exitArbitrage.futureOrders.length)
    return

  let validSpot =
    exitArbitrage.spotOrders[0].price != exitArbitrage.maxPrice.spot ||
    !isVolatile(step, VolatileDirection.Spot, exitArbitrage.maxPrice.spot)

  let validFuture =
    exitArbitrage.futureOrders[0].price != exitArbitrage.maxPrice.future ||
    !isVolatile(step, VolatileDirection.Future, exitArbitrage.maxPrice.future)

  if (!validFuture || !validSpot)
    return

  if (step.executed)
    return

  delete step.future.result
  delete step.spot.result

  const { spotArbitrageOrder, futureArbitrageOrder, executed } = computeOrders(
    entry,
    exchange,
    exitArbitrage,
    spotMarket,
    futureMarket,
    validOrder
  ) ?? {}

  if(!spotArbitrageOrder || !futureArbitrageOrder)
    return

  entry.remainingQuantity -= executed;

  if (!isOutsideTolerance(
    entry.quantity,
    entry.remainingQuantity,
    10
  )) {
    step.executed = true
  }

  const [spotOrder, futureOrder] = await Promise.allSettled([
    createSellSpotOrder(spotArbitrageOrder),
    createBuyFutureOrder(futureArbitrageOrder)
  ])

  const hasError =
    spotOrder.status === 'rejected' ||
    futureOrder.status === 'rejected'

  if (hasError)
    throw new CancelOrderError(
      spotOrder.status == 'fulfilled' ? spotOrder.value : null,
      futureOrder.status == 'fulfilled' ? futureOrder.value : null
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

      if (spotDone &&
        !futureDone &&
        !result.nextFuture) {
        const newFuturePrice = result.spotOrder.average! / (1 + percent / 100)

        retryOrder(
          'futureOrder',
          exchange,
          result,
          futureOrdersCatch,
          newFuturePrice,
          futureMarket,
          validOrder,
          createBuyFutureOrder
        )
      }

      if (!spotDone &&
        futureDone &&
        !result.nextSpot) {
        const newSpotPrice = result.futureOrder.average! * (1 + percent / 100)

        retryOrder(
          'spotOrder',
          exchange,
          result,
          spotOrdersCatch,
          newSpotPrice,
          spotMarket,
          validOrder,
          createSellSpotOrder
        )
      }

      finished = spotDone && futureDone
    } catch (err) {
      await clearAndWait()

      throw new CancelOrderError(
        result.spotOrder,
        result.futureOrder
      )
    }
  }

  await clearAndWait()

  return {
    spotOrder: result.spotOrder,
    futureOrder: result.futureOrder,
  }
}