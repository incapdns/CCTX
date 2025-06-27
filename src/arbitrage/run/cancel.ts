import { Exchange as CcxtExchange, Order } from 'ccxt';
import { Exchange } from "../../exchange";
import { OrderCatch } from './catch';
import { cancelWithRetry, OrderSnapshot, prepareCreateOrder, syncOrder } from './common';

export class CancelOrderError extends Error {
  private spotOrder: Order
  private futureOrder: Order

  constructor(spotOrder: Order | null, futureOrder: Order | null) {
    super("Not all orders completed")

    this.spotOrder = spotOrder
    this.futureOrder = futureOrder
  }

  public getSpotOrder() {
    return this.spotOrder
  }

  public getFutureOrder() {
    return this.futureOrder
  }
}

const syncCurrent = (
  { spotOrder, futureOrder }: OrderSnapshot,
  spotOrdersCatch: OrderCatch,
  futureOrdersCatch: OrderCatch
) => {
  const [spot, future] = [spotOrdersCatch.current(), futureOrdersCatch.current()]

  if(spotOrder)
    syncOrder([spotOrder], spot)

  if(futureOrder)
    syncOrder([futureOrder], future)
}

const commonFilter = (order: Order) =>
  order.remaining != undefined &&
  order.filled != undefined

const syncNext = async (
  { spotOrder, futureOrder }: OrderSnapshot,
  spotOrdersCatch: OrderCatch,
  futureOrdersCatch: OrderCatch
) => {
  const done = (order: Order) =>
    commonFilter(order) &&
    (['closed', 'canceled', 'filled'].includes(order.status) ||
      order.remaining == 0)

  const spotDone = !spotOrder || done(spotOrder)
  const futureDone = !futureOrder || done(futureOrder)

  const [spot, future] = await Promise.all([
    !spotDone ? spotOrdersCatch.next() : [],
    !futureDone ? futureOrdersCatch.next() : []
  ])

  syncOrder([spotOrder], spot)
  syncOrder([futureOrder], future)
}

const canContinue = (snapshot: OrderSnapshot) => {
  const done = (order: Order) =>
    commonFilter(order) &&
    order.remaining == 0

  if(!snapshot.futureOrder || !snapshot.spotOrder)
    return false

  const spotDone = done(snapshot.spotOrder)
  const futureDone = done(snapshot.futureOrder)

  return spotDone && futureDone
}

const canRedo = (snapshot: OrderSnapshot) => {
  const doneSpot = (order: Order) =>
    commonFilter(order) &&
    (order.side == 'sell' ||
      ['closed', 'canceled', 'filled'].includes(order.status))

  const doneFuture = (order: Order) =>
    commonFilter(order) &&
    (order.side == 'buy' ||
      ['closed', 'canceled', 'filled'].includes(order.status))

  const spotDone = !snapshot.spotOrder || doneSpot(snapshot.spotOrder)
  const futureDone = !snapshot.futureOrder || doneFuture(snapshot.futureOrder)

  return spotDone && futureDone
}

const redo = async (
  snapshot: OrderSnapshot,
  manager: CcxtExchange,
  symbol: string
) => {
  let quantity = { spot: 0, future: 0 }

  if(snapshot.spotOrder)
    quantity.spot = snapshot.spotOrder.side == 'buy' ?
      snapshot.spotOrder.filled :
      snapshot.spotOrder.remaining

  const contractSize = manager.market(`${symbol}:USDT`).contractSize ?? 1

  if(snapshot.futureOrder)
    quantity.future = snapshot.futureOrder.side == 'sell' ?
      snapshot.futureOrder.filled * contractSize :
      snapshot.futureOrder.remaining * contractSize

  const redoSpot = prepareCreateOrder(manager, symbol, 'sell')
  const redoFuture = prepareCreateOrder(manager, `${symbol}:USDT`, 'buy', true)

  await Promise.allSettled([
    quantity.spot > 0 && redoSpot(undefined, quantity.spot),
    quantity.future > 0 && redoFuture(undefined, quantity.future)
  ])

  return true
}

export const tryCancel = async (
  exchange: Exchange,
  symbol: string,
  snapshot: OrderSnapshot,
  spotOrdersCatch: OrderCatch,
  futureOrdersCatch: OrderCatch,
): Promise<boolean> => {
  if(!snapshot.futureOrder && !snapshot.spotOrder)
    return true

  const manager = exchange.getManager()

  await Promise.all([
    snapshot.spotOrder && cancelWithRetry(exchange, snapshot.spotOrder),
    snapshot.futureOrder && cancelWithRetry(exchange, snapshot.futureOrder)
  ])

  await syncCurrent(
    snapshot,
    spotOrdersCatch,
    futureOrdersCatch
  )

  if (canContinue(snapshot))
    return false

  if (canRedo(snapshot))
    return await redo(
      snapshot,
      manager,
      symbol
    )

  while (true) {
    await syncNext(
      snapshot,
      spotOrdersCatch,
      futureOrdersCatch
    )

    if (canContinue(snapshot))
      return false

    if (canRedo(snapshot))
      return await redo(
        snapshot,
        manager,
        symbol
      )
  }
}