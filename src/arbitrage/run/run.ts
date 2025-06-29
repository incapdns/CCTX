import { Order, OrderBook } from "ccxt";
import { Exchange } from "../../exchange";
import { ArbitrageDirection } from "../compute/common";
import { CancelOrderError, tryCancel } from './cancel';
import { catchOrders, CatchReturn, OrderCatch } from './catch';
import { ArbitrageNonce, OrderSnapshot, Step, StepManager, syncOrder } from './common';
import { runEntryArbitrage } from './steps/entry';
import { runExitArbitrage } from './steps/exit';
import { isOutsideTolerance } from "../compute/entry";

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
  entry: Entry,
  step: Step,
  direction: ArbitrageDirection,
  spotOrdersCatch: OrderCatch,
  futureOrdersCatch: OrderCatch,
) => {
  if (!snapshot || !snapshot.spotOrder || !snapshot.futureOrder)
    return;

  snapshot.spotOrder.info = snapshot.spotOrder.info || {}
  snapshot.futureOrder.info = snapshot.futureOrder.info || {}

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

  const redo: Order | false =
    snapshot.spotOrder.info?.source == 'redo' ?
      snapshot.spotOrder.info.original : false

  const quantity = redo ?
    -(redo.remaining + redo.filled) :
    snapshot.spotOrder.filled + snapshot.spotOrder.remaining

  if (direction == ArbitrageDirection.Entry) {
    entry.remainingQuantity -= quantity

    const quantityExecuted = entry.quantity - entry.remainingQuantity

    step.executed = !isOutsideTolerance(
      entry.quantity,
      quantityExecuted,
      10
    )
  } else {
    entry.exited += quantity

    step.executed = entry.exited == entry.quantity
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

  const eachAttempt = (attempt: OrderSnapshot) =>
    processAttempt(
      attempt,
      entry,
      step,
      direction,
      spotOrdersCatch,
      futureOrdersCatch
    )

  const eachPromise = async (p: Promise<OrderBook>): Promise<OrderSnapshot> => {
    try {
      await p

      return stepFn({
        exchange,
        symbol,
        entry,
        step,
        arbitrageNonce,
        timeout,
        spotOrdersCatch,
        futureOrdersCatch
      })
        .catch(e =>
          catchCancelOrder(e, exchange, symbol, spotOrdersCatch, futureOrdersCatch)
        )
    } catch (e) { }
  }

  while (exchange.running.includes(symbol) && !step.executed) {
    const promises: Array<Promise<OrderBook>> = []

    promises.push(
      exchange
        .getManager()
        .watchOrderBook(symbol, 10)
        .then(result => (
          step.spot.result = result
        ))
    )

    promises.push(
      exchange
        .getManager()
        .watchOrderBook(futureSymbol, 10)
        .then(result => (
          step.future.result = result
        ))
    )

    const attempts =
      promises
        .map(eachPromise)

    Promise
      .all(attempts)
      .then(attempts => attempts.map(eachAttempt))

    await Promise.allSettled(promises)
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
      executed: false,
      spot: {},
      future: {}
    },
    exit: {
      executed: false,
      spot: {},
      future: {}
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
    if (parts.length > 0) {
      const values = parts.map(Number)
      entry.quantity = values[0]
      entry.exited = 0
      entry.remainingQuantity = 0
      entry.profitPercent = values[1] ?? 0
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