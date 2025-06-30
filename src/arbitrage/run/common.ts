import { Exchange as CcxtExchange, Market, Order, OrderBook, OrderSide } from 'ccxt';
import Decimal from 'decimal.js';
import { Exchange } from '../../exchange';
import { ArbitrageOrder } from "../compute/common";

export interface OrderSnapshot {
  spotOrder: Order,
  futureOrder: Order
}

export interface Step {
  executed: boolean,
  spot?: {
    result?: OrderBook,
    lastPrice?: [number, number],
  },
  future?: {
    result?: OrderBook,
    lastPrice?: [number, number],
  }
  lastOrder?: {
    promise: Promise<void>,
    finished: boolean
  }
}

export interface StepManager {
  entry: Step;
  exit: Step;
}

export interface ArbitrageNonce {
  spot?: number,
  future?: number
}

export const prepareCreateOrder = (exchange: CcxtExchange, symbol: string, orderSide: OrderSide, reduceOnly = false) => async (order?: ArbitrageOrder, marketQuantity?: number) => {
  while (true) {
    try {
      reduceOnly = reduceOnly && orderSide === 'buy' 
      
      return await exchange.createOrder(
        symbol,
        marketQuantity ?
          'market' : 'limit',
        orderSide,
        Number(
          exchange.amountToPrecision(
            symbol,
            symbol.includes(':') ?
              Decimal(marketQuantity || order.quantity).div(exchange.market(symbol).contractSize ?? 1).toNumber() :
              (marketQuantity || order.quantity)
          )
        ),
        !marketQuantity ? Number(
          exchange.priceToPrecision(
            symbol,
            order.price
          )
        ) : undefined,
        {
          recvWindow: 20000,
          ...reduceOnly &&{
            reduceOnly: true,
            positionSide: 'SHORT'
          },
          ...!reduceOnly && symbol.includes(':') && {
            openType: 1,
            leverage: 1
          }
        }
      )
    } catch (error) {
      const errorMatch = error?.message?.match('code\.:([0-9]+)')
      const errorCode = errorMatch ? errorMatch[1] : false

      const shouldRetry =
        typeof error == 'object' &&
        (error?.constructor?.name == 'RateLimitExceeded' ||
          error?.name == 'RequestTimeout' ||
          ['429', '510'].includes(errorCode) ||
          !errorCode)

      if (!shouldRetry)
        throw error
    }
  }
}

export const createOrderValidator = (exchange: CcxtExchange) => (order: ArbitrageOrder, market: Market) => {
  let { price, quantity } = order
  quantity = Decimal(order.quantity).div(market.contractSize ?? 1).toNumber()

  try {
    price = Number(exchange.priceToPrecision(market.symbol, price))
    quantity = Number(exchange.amountToPrecision(market.symbol, quantity))
  } catch (err) {
    return false
  }

  const cost = Decimal(price).mul(quantity).toNumber()

  return (!market.limits.price?.min || price >= market.limits.price.min) &&
    (!market.limits.price?.max || price <= market.limits.price.max) &&
    (!market.limits.amount?.min || quantity >= market.limits.amount.min) &&
    (!market.limits.amount?.max || quantity <= market.limits.amount.max) &&
    (!market.limits.cost?.min || cost >= market.limits.cost.min) &&
    (!market.limits.cost?.max || cost <= market.limits.cost.max);
}

export const syncOrder = (orders: Order[], updates: Order[]) => {
  for (const order of updates) {
    let equivalent = orders.find(o => o.id == order.id)
    
    if (!equivalent) continue
    
    equivalent.status = order.status
    equivalent.filled = order.filled
    equivalent.remaining = order.remaining
    equivalent.average = order.average
  }
}

export const cancelWithRetry = async (exchange: Exchange, order: Order): Promise<boolean> => {
  const manager = exchange.getManager()

  while (true) {
    try {
      await manager.cancelOrder(order.id, order.symbol)
      return true
    } catch (error) {
      const errorMatch = error?.message?.match('code\.:([0-9]+)')
      const errorCode = errorMatch ? errorMatch[1] : '0'

      const shouldRetry =
        typeof error == 'object' &&
        (error?.constructor?.name == 'RateLimitExceeded' ||
          error?.name == 'RequestTimeout' ||
          ['429', '510'].includes(errorCode) ||
          !errorCode)

      if (!shouldRetry)
        return false
    }
  }
}