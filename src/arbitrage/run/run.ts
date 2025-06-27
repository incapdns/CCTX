import { Order } from "ccxt";
import { Exchange } from "../../exchange";
import { ArbitrageDirection } from "../compute/common";
import { CancelOrderError, tryCancel } from './cancel';
import { catchOrders, CatchReturn } from './catch';
import { ArbitrageNonce, prepareCreateOrder, Step, syncOrder } from './common';
import { runEntryArbitrage } from './steps/entry';
import { runExitArbitrage } from './steps/exit';
import Decimal from "decimal.js";

export interface Arbitrage {
  symbol: string,
  exchange: Exchange,
  amount: number,
  timeout: number,
  resume: string
}

export interface Entry {
  profitPercent: number,
  executed: number,
  amount: number
}

const rethrow = (e: any) => {
  const shouldThrow =
    typeof e == 'object' &&
    e instanceof CancelOrderError

  if (shouldThrow)
    throw e
}

export const runArbitrage = async ({ symbol, exchange, amount, ...other }: Arbitrage) => {
  const manager = exchange.getManager()

  await manager.loadMarkets()

  await exchange.waitConnect()

  const entry: Entry = {
    profitPercent: 0,
    executed: 0,
    amount
  }

  if (exchange.running.includes(symbol))
    return

  try {
    const spotMarket = manager.market(symbol)
    const minSpotCost = spotMarket.limits.cost?.min ?? 0

    const futureMarket = manager.market(`${symbol}:USDT`)
    const minFutureCost = futureMarket.limits.cost?.min ?? 0

    const valid =
      amount >= minSpotCost * 1.07 &&
      amount >= minFutureCost * 1.07

    if (!valid)
      return
  } catch (err) {
    return
  }

  exchange.running.push(symbol)
  exchange.running.push(`${symbol}:USDT`)

  const step: Step = {
    direction: ArbitrageDirection.Entry,
    executed: false
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

  const stepFns = [runEntryArbitrage, runExitArbitrage]

  if (other.resume) {
    const parts = other.resume.split(',')
    if (parts.length == 2) {
      stepFns.splice(0, 1)
      step.direction = ArbitrageDirection.Exit
      const values = parts.map(Number)
      entry.executed = values[0]
      entry.profitPercent = values[1]
    }
  }

  for (const stepFn of stepFns) {
    step.promise = new Promise(resolve => step.resolve = resolve)

    while (exchange.running.includes(symbol) && !step.executed) {
      try {
        step.spot = {
          promise: exchange
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
                timeout: other.timeout,
                spotOrdersCatch,
                futureOrdersCatch
              })
            ))
            .catch(rethrow),

          result: step.spot?.result
        }

        step.future = {
          promise: exchange
            .getManager()
            .watchOrderBook(`${symbol}:USDT`, 10)
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
                timeout: other.timeout
              })
            ))
            .catch(rethrow),

          result: step.future?.result
        }

        await Promise.all([
          step.spot.promise,
          step.future.promise
        ])
      } catch (e) {
        const shouldCancel =
          typeof e == 'object' &&
          e instanceof CancelOrderError

        if (shouldCancel) {
          const needExit =
            await tryCancel(
              exchange,
              symbol,
              {
                spotOrder: e.getSpotOrder(),
                futureOrder: e.getFutureOrder()
              },
              spotOrdersCatch,
              futureOrdersCatch
            )

          if (needExit)
            return await exit()
        } else {
          return await exit()
        }
      }
    }

    const { spotOrder, futureOrder } = await step.promise

    const profitPercent = Decimal(futureOrder.average)
      .minus(spotOrder.average)
      .div(spotOrder.average)
      .mul(100)

    entry.profitPercent = profitPercent.toNumber()

    step.executed = false
    step.direction = ArbitrageDirection.Exit
    delete step.future
    delete step.spot
    delete arbitrageNonce.future
    delete arbitrageNonce.spot
  }

  await exit()
}