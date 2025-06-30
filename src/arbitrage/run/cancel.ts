import { Exchange as CcxtExchange, Order } from 'ccxt';
import { Exchange } from "../../exchange";
import { CatchReturn, OrderCatch } from './catch';
import { cancelWithRetry, OrderSnapshot, prepareCreateOrder, syncOrder } from './common';

export class CancelOrderError extends Error {
  private spotOrder: Order
  private futureOrder: Order
  private direction: 'entry' | 'exit'

  constructor(spotOrder: Order | null, futureOrder: Order | null, direction: 'entry' | 'exit') {
    super("Not all orders completed")

    this.spotOrder = spotOrder
    this.futureOrder = futureOrder
    this.direction = direction
  }

  public getSpotOrder() {
    return this.spotOrder
  }

  public getFutureOrder() {
    return this.futureOrder
  }

  public getDirection() {
    return this.direction
  }
}

const syncCurrent = (
  { spotOrder, futureOrder }: OrderSnapshot,
  spotOrdersCatch: OrderCatch,
  futureOrdersCatch: OrderCatch
) => {
  const [spot, future] = [spotOrdersCatch.current(), futureOrdersCatch.current()]

  if (spotOrder)
    syncOrder([spotOrder], spot)

  if (futureOrder)
    syncOrder([futureOrder], future)
}

const commonFilter = (order: Order) =>
  order.remaining != undefined &&
  order.filled != undefined

const syncNext = async (
  { spotOrder, futureOrder }: OrderSnapshot,
  spotOrdersCatch: OrderCatch,
  futureOrdersCatch: OrderCatch,
  lastNonces: { spot: number, future: number }
) => {
  const done = (order: Order) =>
    commonFilter(order) &&
    (['closed', 'canceled', 'filled'].includes(order.status) ||
      order.remaining == 0)

  const spotDone = !spotOrder || done(spotOrder)
  const futureDone = !futureOrder || done(futureOrder)

  const [spot, future] = await Promise.all([
    !spotDone ? spotOrdersCatch.next(lastNonces.spot + 1) : [],
    !futureDone ? futureOrdersCatch.next(lastNonces.future + 1) : []
  ]) as [CatchReturn, CatchReturn]

  if (spot.nonce != undefined)
    lastNonces.spot = spot.nonce

  if (future.nonce != undefined)
    lastNonces.future = future.nonce

  syncOrder([spotOrder], spot)
  syncOrder([futureOrder], future)
}

const canContinue = (snapshot: OrderSnapshot) => {
  const done = (order: Order) =>
    commonFilter(order) &&
    order.remaining == 0

  if (!snapshot.futureOrder || !snapshot.spotOrder)
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
  snapshot:   OrderSnapshot,
  manager:    CcxtExchange,
  symbol:     string,
  side:       'entry' | 'exit',
): Promise<OrderSnapshot> => {
  const spotFilled   = snapshot.spotOrder?.filled   ?? 0
  const futureFilled = snapshot.futureOrder?.filled ?? 0
  const futSymbol    = `${symbol}:USDT`

  // imbalance sempre em UNIDADES de spot
  const imbalance = side === 'entry'
    ? futureFilled - spotFilled
    : spotFilled - futureFilled

  if (imbalance === 0) {
    return snapshot
  }

  // factories prontas (undefined → market order)
  const redoSpot   = prepareCreateOrder(manager, symbol,      side === 'entry' ? 'buy'  : 'sell')
  const redoFuture = prepareCreateOrder(manager, futSymbol,   side === 'entry' ? 'sell' : 'buy', /*market*/ true)

  let spotOrder:   Order | undefined = snapshot.spotOrder
  let futureOrder: Order | undefined = snapshot.futureOrder

  if (imbalance > 0) {
    // perna atrasada = spot
    spotOrder = await redoSpot(undefined, imbalance)
  }
  else {
    // perna atrasada = future (usa Math.abs pra ficar +)
    futureOrder = await redoFuture(undefined, Math.abs(imbalance))
  }

  return {
    spotOrder:   spotOrder   ?? { remaining: 0, filled: 0 } as Order,
    futureOrder: futureOrder ?? { remaining: 0, filled: 0 } as Order,
  }
}

export const tryCancel = async (
  exchange: Exchange,
  symbol: string,
  snapshot: OrderSnapshot,
  spotOrdersCatch: OrderCatch,
  futureOrdersCatch: OrderCatch,
  direction: 'entry' | 'exit'
): Promise<OrderSnapshot> => {
  if (!snapshot.futureOrder && !snapshot.spotOrder)
    return snapshot

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
    return snapshot

  if (canRedo(snapshot))
    return await redo(
      snapshot,
      manager,
      symbol,
      direction
    )

  const lastNonces = { spot: -1, future: -1 }

  while (true) {
    await syncNext(
      snapshot,
      spotOrdersCatch,
      futureOrdersCatch,
      lastNonces
    )

    if (canContinue(snapshot))
      return snapshot

    if (canRedo(snapshot))
      return await redo(
        snapshot,
        manager,
        symbol,
        direction
      )
  }
}