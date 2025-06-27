import { Order } from 'ccxt';
import Decimal from 'decimal.js';
import { Exchange } from "../../../exchange";
import { doArbitrage } from '../../compute';
import { ArbitrageDirection, ArbitrageOrder } from "../../compute/common";
import { CancelOrderError } from '../cancel';
import { CatchReturn, OrderCatch } from '../catch';
import { createOrderValidator, CurrentArbitrageNonce, prepareCreateOrder, Step, syncOrder } from '../common';
import { Entry } from '../run';
import { rejectTimeout, Result, retryOrder } from './common';

interface EntryArbitrage {
  exchange: Exchange,
  symbol: string,
  entry: Entry,
  step: Step,
  currentArbitrageNonce: CurrentArbitrageNonce,
  spotOrdersCatch: OrderCatch,
  futureOrdersCatch: OrderCatch,
  timeout: number
}

const percent = 0.40

const limitToPrecision = (value: Decimal.Value, reference: Decimal.Value): Decimal => {
  const result = Decimal(value)
    .toDecimalPlaces(Decimal(reference).dp(), Decimal.ROUND_DOWN)

  return result
}

export const runEntryArbitrage = async ({
  exchange,
  symbol,
  entry,
  step,
  currentArbitrageNonce,
  spotOrdersCatch,
  futureOrdersCatch,
  timeout
}: EntryArbitrage) => {
  if (step.executed) return

  if (!step.future?.result || !step.spot?.result) return

  const sameSpot = currentArbitrageNonce.spot == step.spot?.result?.nonce
  const sameFuture = currentArbitrageNonce.future == step.future?.result?.nonce

  if (sameFuture && sameSpot) return

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

  const entryArbitrage = doArbitrage({
    direction: ArbitrageDirection.Entry,
    spotBook: spotBook.asks,
    futureBook: futureBook.bids,
    percent,
    amount: entry.amount,
    marginAmountPercent: 10
  })

  currentArbitrageNonce.spot = step.spot.result.nonce
  currentArbitrageNonce.future = step.future.result.nonce

  if (!entryArbitrage.completed) return

  if(entryArbitrage.maxPrice.spot == entryArbitrage.spotOrders[0].price ||
    entryArbitrage.maxPrice.future == entryArbitrage.futureOrders[0].price)
    return

  if (!step.executed &&
    step.direction == ArbitrageDirection.Entry) {
    step.executed = true
    
    const contractSize = futureMarket.contractSize ?? 1

    const contractQuantity =
      limitToPrecision(Decimal(entryArbitrage.executed).div(contractSize), futureMarket?.precision.amount ?? 1)

    entryArbitrage.executed = contractQuantity
      .mul(contractSize)
      .toNumber()

    entry.profitPercent = entryArbitrage.profitPercent
    entry.executed = entryArbitrage.executed

    const validSpot = entryArbitrage.executed >= (spotMarket.precision.amount ?? 0)

    const validFuture =
      Decimal(entryArbitrage.executed).div(futureMarket.contractSize ?? 1).toNumber() >=
      (futureMarket.precision.amount ?? 0)

    if (!validSpot || !validFuture)
      throw new Error("Invalid precision because amount is too small")

    const spotArbitrageOrder: ArbitrageOrder = {
      price: entryArbitrage.maxPrice.spot,
      quantity: entryArbitrage.executed
    }

    if (!validOrder(spotArbitrageOrder, spotMarket))
      throw new Error("Invalid spot order")

    const futureArbitrageOrder: ArbitrageOrder = {
      price: entryArbitrage.maxPrice.future,
      quantity: entryArbitrage.executed
    }

    if (!validOrder(futureArbitrageOrder, futureMarket))
      throw new Error("Invalid future order")

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
    }

    let lastNonces = { spot: -1, future: -1 }

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
          const newFuturePrice = result.spotOrder.average! * (1 + percent / 100)

          retryOrder(
            'futureOrder',
            exchange,
            result,
            futureOrdersCatch,
            newFuturePrice,
            futureMarket,
            validOrder,
            createSellFutureOrder
          )
        }

        if (!spotDone &&
          futureDone &&
          !result.nextSpot) {
          const newSpotPrice = result.futureOrder.average! / (1 + percent / 100)

          retryOrder(
            'spotOrder',
            exchange,
            result,
            spotOrdersCatch,
            newSpotPrice,
            spotMarket,
            validOrder,
            createBuySpotOrder
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

    step.resolve({
      spotOrder: result.spotOrder,
      futureOrder: result.futureOrder
    })
  }
}