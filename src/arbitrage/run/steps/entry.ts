import { Order } from 'ccxt';
import { Exchange } from "../../../exchange";
import { doArbitrage } from '../../compute';
import { ArbitrageDirection } from "../../compute/common";
import { CancelOrderError } from '../cancel';
import { CatchReturn, OrderCatch } from '../catch';
import { ArbitrageNonce, createOrderValidator, prepareCreateOrder, Step, syncOrder } from '../common';
import { Entry } from '../run';
import { ArbitrageValidation, computeOrders, createOrderTracker, isValidArbitrage, rejectTimeout, Result, waitTimeout } from './common';

interface EntryArbitrage {
  exchange: Exchange,
  symbol: string,
  entry: Entry,
  step: Step,
  arbitrageNonce: ArbitrageNonce,
  spotOrdersCatch: OrderCatch,
  futureOrdersCatch: OrderCatch,
  timeout: number,
  percent: number,
  index: number
}

export const runEntryArbitrage = async ({
  exchange,
  symbol,
  entry,
  step,
  arbitrageNonce,
  spotOrdersCatch,
  futureOrdersCatch,
  timeout,
  percent,
  index
}: EntryArbitrage) => {
  if (step.executed)
    return

  if (!step.future?.result || !step.spot?.result)
    return

  if (step.lastOrder && !step.lastOrder?.finished)
    return

  const sameSpot = arbitrageNonce.spot == step.spot?.result?.nonce
  const sameFuture = arbitrageNonce.future == step.future?.result?.nonce

  if (sameFuture && sameSpot)
    return

  const manager = exchange.getManager()

  const validOrder = createOrderValidator(manager)

  const createBuySpotOrder = prepareCreateOrder(manager, symbol, 'buy')
  const createSellFutureOrder = prepareCreateOrder(manager, `${symbol}:USDT`, 'sell')

  const [spotBook, futureBook] = [
    step.spot!.result!,
    step.future!.result!
  ]

  const spotMarket = manager.market(symbol)
  const futureMarket = manager.market(`${symbol}:USDT`)

  let entryArbitrage = doArbitrage({
    direction: ArbitrageDirection.Entry,
    spotOrders: spotBook.asks,
    futureOrders: futureBook.bids,
    percent,
    amount: entry.quantity * 2,
    marginQuantityPercent: 10,
    contractSize: futureMarket.contractSize ?? 1
  })

  entryArbitrage.executed *= 0.7 // 30% less than the computed value;

  arbitrageNonce.spot = step.spot.result.nonce
  arbitrageNonce.future = step.future.result.nonce

  const arbitrageValidation = isValidArbitrage(
    entryArbitrage,
    spotBook,
    futureBook,
    ArbitrageDirection.Entry,
    index,
    step
  )

  if (arbitrageValidation == ArbitrageValidation.Empty)
    return

  if (arbitrageValidation == ArbitrageValidation.Invalid) {
    await waitTimeout(3000)

    const spotOrders = step.spot.result.asks
    const futureOrders = step.future.result.bids

    entryArbitrage = doArbitrage({
      direction: ArbitrageDirection.Entry,
      spotOrders,
      futureOrders,
      percent,
      amount: entry.quantity * 2,
      marginQuantityPercent: 10,
      contractSize: futureMarket.contractSize ?? 1
    })

    entryArbitrage.executed *= 0.7 // 30% less than the computed value;

    const arbitrageValidation = isValidArbitrage(
      entryArbitrage,
      step.spot.result,
      step.future.result,
      ArbitrageDirection.Entry,
      index,
      step
    )

    const isValid = arbitrageValidation == ArbitrageValidation.Valid

    if (!isValid)
      return

    if (step.lastOrder && !step.lastOrder?.finished)
      return
  }

  if (step.executed)
    return

  delete step.future.result
  delete step.spot.result

  const remainingQuantityForEntry = Math.min(
    entry.quantity - entry.entered,
    entry.quantity - entry.temp.entry,
    entryArbitrage.executed,
  )

  const { spotArbitrageOrder, futureArbitrageOrder, executed } = computeOrders(
    entry,
    exchange,
    remainingQuantityForEntry,
    entryArbitrage,
    spotMarket,
    futureMarket,
    ArbitrageDirection.Entry,
    validOrder
  ) ?? {}

  if (!executed)
    return

  if (executed > entry.quantity - entry.temp.entry)
    return

  const tracker = createOrderTracker()
  step.lastOrder = tracker

  entry.temp.entry += executed

  const [spotOrder, futureOrder] = await Promise.allSettled([
    createBuySpotOrder(spotArbitrageOrder),
    createSellFutureOrder(futureArbitrageOrder)
  ])

  const hasError =
    spotOrder.status === 'rejected' ||
    futureOrder.status === 'rejected'

  if (hasError)
    throw new CancelOrderError(
      spotOrder.status == 'fulfilled' ? spotOrder.value : null,
      futureOrder.status == 'fulfilled' ? futureOrder.value : null,
      'entry'
    )

  let finished = false,
    spotDone = false,
    futureDone = false;

  const time = rejectTimeout<[CatchReturn, CatchReturn]>(timeout)

  const result: Result = {
    futureOrder: futureOrder.value,
    spotOrder: spotOrder.value
  }

  result.spotOrder.side = 'buy'
  result.spotOrder.symbol = symbol

  result.futureOrder.side = 'sell'
  result.futureOrder.symbol = `${symbol}:USDT`

  const clearAndWait = async () => {
    clearTimeout(time.timeout)
    clearTimeout(result.nextSpot?.timeout)
    clearTimeout(result.nextFuture?.timeout)

    if (result.nextSpot?.entered)
      await result.nextSpot?.promise

    if (result.nextFuture?.entered)
      await result.nextFuture?.promise

    tracker.resolve()
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
        'entry'
      )
    }
  }

  await clearAndWait()

  return {
    spotOrder: result.spotOrder,
    futureOrder: result.futureOrder,
  }
}