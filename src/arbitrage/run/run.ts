import { Order } from "ccxt";
import { Exchange } from "../../exchange";
import { ArbitrageDirection } from "../compute/common";
import { CancelOrderError, tryCancel } from './cancel';
import { catchOrders, CatchReturn, OrderCatch } from './catch';
import { ArbitrageNonce, OrderSnapshot, StepManager, syncOrder } from './common';
import { runEntryArbitrage } from './steps/entry';
import { runExitArbitrage } from './steps/exit';

export interface Arbitrage {
  symbol: string,
  exchange: Exchange,
  quantity: number,
  timeout: number,
  resume: string
}

export interface Entry {
  profitPercent: number,
  /** The user input quantity to be executed */
  quantity: number,
  /** Remaining quantity to be executed */
  remainingQuantity: number,
  /** Total quantity that was exited */
  exited: number,
}

const catchCancelOrder = async (
  e: any,
  exchange: Exchange,
  symbol: string,
  spotOrdersCatch: OrderCatch,
  futureOrdersCatch: OrderCatch
) => {
  const shouldCancel =
    typeof e == 'object' &&
    e instanceof CancelOrderError

  if (!shouldCancel)
    return

  return await tryCancel(
    exchange,
    symbol,
    {
      spotOrder: e.getSpotOrder(),
      futureOrder: e.getFutureOrder()
    },
    spotOrdersCatch,
    futureOrdersCatch
  )
}

interface RunStep {
  stepManager: StepManager,
  direction: ArbitrageDirection,
  exchange: Exchange,
  arbitrageNonce: ArbitrageNonce,
  spotOrdersCatch: OrderCatch,
  futureOrdersCatch: OrderCatch,
  timeout: number,
  entry: Entry,
  symbol: string,
}

const processAttempt = async (
  snapshot: OrderSnapshot,
  spotOrdersCatch: OrderCatch,
  futureOrdersCatch: OrderCatch,
) => {
  if (!snapshot || !snapshot.spotOrder || !snapshot.futureOrder)
    return;

  let spotDone = snapshot.spotOrder.remaining == 0,
    futureDone = snapshot.futureOrder.remaining == 0

  const lastNonces = { spot: -1, future: -1 }

  const done = (order: Order) =>
    order.remaining == 0

  while (!spotDone || !futureDone) {
    const [spot, future] = await Promise.race([
      Promise.all([
        !spotDone ? spotOrdersCatch.next(lastNonces.spot + 1) : [],
        !futureDone ? futureOrdersCatch.next(lastNonces.future + 1) : []
      ])
    ]) as [CatchReturn, CatchReturn]

    if (spot.nonce != undefined)
      lastNonces.spot = spot.nonce

    if (future.nonce != undefined)
      lastNonces.future = future.nonce

    syncOrder([snapshot.spotOrder], spot)
    syncOrder([snapshot.futureOrder], future)

    spotDone = done(snapshot.spotOrder)
    futureDone = done(snapshot.futureOrder)
  }
}

const runStep = async ({
  stepManager,
  direction,
  exchange,
  arbitrageNonce,
  spotOrdersCatch,
  futureOrdersCatch,
  timeout,
  entry,
  symbol
}: RunStep) => {
  const futureSymbol = `${symbol}:USDT`

  const stepFn = direction == ArbitrageDirection.Entry ?
    runEntryArbitrage :
    runExitArbitrage

  const step = direction == ArbitrageDirection.Entry ?
    stepManager.entry :
    stepManager.exit

  while (exchange.running.includes(symbol) && !step.executed) {
    const attempts: Array<Promise<{
      spotOrder: Order;
      futureOrder: Order;
    }>> = []

    attempts.push(
      exchange
        .getManager()
        .watchOrderBook(symbol, 10)
        .then(result => (
          step.spot.result = result,
          stepFn({
            exchange,
            symbol,
            entry,
            step,
            arbitrageNonce,
            timeout,
            spotOrdersCatch,
            futureOrdersCatch
          })
        ))
        .catch(err =>
          catchCancelOrder(err, exchange, symbol, spotOrdersCatch, futureOrdersCatch)
        )
    )

    attempts.push(
      exchange
        .getManager()
        .watchOrderBook(futureSymbol, 10)
        .then(result => (
          step.future.result = result,
          stepFn({
            exchange,
            symbol,
            entry,
            step,
            arbitrageNonce,
            spotOrdersCatch,
            futureOrdersCatch,
            timeout
          })
        ))
        .catch(err =>
          catchCancelOrder(err, exchange, futureSymbol, spotOrdersCatch, futureOrdersCatch)
        )
    )

    const [first, second] = await Promise.all(attempts)

    processAttempt(
      first,
      spotOrdersCatch,
      futureOrdersCatch
    )

    processAttempt(
      second,
      spotOrdersCatch,
      futureOrdersCatch
    )
  }
}

export const runArbitrage = async ({ symbol, exchange, quantity: amount, ...other }: Arbitrage) => {
  const manager = exchange.getManager()

  await manager.loadMarkets()

  await exchange.waitConnect()

  const entry: Entry = {
    profitPercent: 0,
    exited: 0,
    quantity: amount,
    remainingQuantity: amount
  }

  if (exchange.running.includes(symbol))
    return

  exchange.running.push(symbol)
  exchange.running.push(`${symbol}:USDT`)

  const stepManager: StepManager = {
    entry: {
      executed: false
    },
    exit: {
      executed: false
    }
  }

  const arbitrageNonce: ArbitrageNonce = {
    spot: 0,
    future: 0
  }

  const spotOrdersCatch = catchOrders(exchange, symbol)
  const futureOrdersCatch = catchOrders(exchange, `${symbol}:USDT`)

  const exit = async () => {
    try {
      await manager.unWatchOrderBook(symbol)
      await manager.unWatchOrderBook(`${symbol}:USDT`)
    } catch (err) {
      console.error(err)
    }

    spotOrdersCatch.unsubscribe()
    futureOrdersCatch.unsubscribe()

    const symbolIndex = exchange.running.findIndex(s => s == symbol)
    exchange.running.splice(symbolIndex, 2)
  }

  const directions = [
    ArbitrageDirection.Entry,
    ArbitrageDirection.Exit
  ]

  if (other.resume) {
    const parts = other.resume.split(',')
    if (parts.length == 2) {
      const values = parts.map(Number)
      entry.quantity = values[0]
      entry.exited = 0
      entry.remainingQuantity = entry.quantity
      entry.profitPercent = values[1]
    }

    directions.splice(0, 1)
  }

  const promises = directions.map(direction =>
    runStep({
      stepManager,
      direction,
      exchange,
      arbitrageNonce,
      spotOrdersCatch,
      futureOrdersCatch,
      timeout: other.timeout,
      entry,
      symbol
    })
  )

  await Promise.all(promises)

  await exit()
}