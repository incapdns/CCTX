import { Order, OrderBook } from "ccxt";
import { Exchange } from "../../exchange";
import { ArbitrageDirection } from "../compute/common";
import { isOutsideTolerance } from "../compute/entry";
import { CancelOrderError, tryCancel } from './cancel';
import { catchOrders, CatchReturn, OrderCatch } from './catch';
import { ArbitrageNonce, OrderSnapshot, Step, StepManager, syncOrder } from './common';
import { runEntryArbitrage } from './steps/entry';
import { runExitArbitrage } from './steps/exit';

export interface Arbitrage {
  symbol: string,
  exchange: Exchange,
  quantity: number,
  timeout: number,
  resume: string,
  entryPercent: number,
  exitPercent: number,
}

export interface Entry {
  profitPercent: number,
  /** The user input quantity to be executed */
  quantity: number,
  /** Total quantity that was entered */
  entered: number,
  /** Total quantity that was exited */
  exited: number,
  temp: {
    entry: number,
    exit: number
  }
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
    futureOrdersCatch,
    e.getDirection()
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
  percent: number
}

const processAttempt = async (
  snapshot: OrderSnapshot,
  entry: Entry,
  step: Step,
  direction: ArbitrageDirection,
  exchange: Exchange
) => {
  if (!snapshot || !snapshot.spotOrder || !snapshot.futureOrder)
    return;

  const manager = exchange.getManager()

  const symbol = snapshot.spotOrder.symbol

  const contractSize = manager.market(`${symbol}:USDT`)?.contractSize ?? 1

  const quantity = 
    (snapshot.futureOrder.filled * contractSize) ||
    snapshot.spotOrder.filled

  if (direction == ArbitrageDirection.Entry) {
    entry.entered += quantity

    step.executed = !isOutsideTolerance(
      entry.quantity,
      entry.entered,
      10
    )
    entry.temp.entry = entry.entered
  } else {
    entry.exited += quantity
    step.executed = entry.exited == entry.quantity
    entry.temp.exit = entry.exited
  }

  if(step.executed)
    console.warn(`Step ${direction} executed for ${snapshot.spotOrder.symbol} with quantity ${entry.quantity}`)
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
  symbol,
  percent
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
      exchange
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
        futureOrdersCatch,
        percent
      })
        .catch(e =>
          catchCancelOrder(e, exchange, symbol, spotOrdersCatch, futureOrdersCatch)
        )
    } catch (e) { }
  }

  while (exchange.running.includes(symbol) && !step.executed) {
    await step.lastOrder?.promise

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

export const runArbitrage = async ({ 
  symbol, 
  exchange, 
  quantity, 
  timeout, 
  entryPercent, 
  exitPercent,
  resume
}: Arbitrage) => {
  const manager = exchange.getManager()

  await manager.loadMarkets()

  await exchange.waitConnect()

  const entry: Entry = {
    profitPercent: 0,
    quantity: quantity,
    exited: 0,
    entered: 0,
    temp: {
      entry: 0,
      exit: 0
    }
  }

  if (exchange.running.includes(symbol))
    return

  exchange.running.push(symbol)
  exchange.running.push(`${symbol}:USDT`)

  const stepManager: StepManager = {
    entry: {
      executed: false,
      spot: {},
      future: {},
    },
    exit: {
      executed: false,
      spot: {},
      future: {},
    },
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

  if (resume) {
    const parts = resume.split(',')
    if (parts.length > 0) {
      const values = parts.map(Number)
      entry.quantity = values[0]
      entry.exited = 0
      entry.entered = 0
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
      timeout,
      entry,
      symbol,
      percent: direction == ArbitrageDirection.Entry ? 
        entryPercent : 
        exitPercent
    })
  )

  await Promise.all(promises)

  await exit()
}