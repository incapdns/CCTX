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
  const done = (order: Order) =>
    commonFilter(order) &&
    ['closed', 'canceled', 'filled'].includes(order.status)

  const spotDone = !snapshot.spotOrder || done(snapshot.spotOrder)
  const futureDone = !snapshot.futureOrder || done(snapshot.futureOrder)

  return spotDone && futureDone
}

type Side = 'entry' | 'exit'

const redo = async (
  snapshot: OrderSnapshot,
  manager: CcxtExchange,
  symbol: string,
  side: Side
): Promise<OrderSnapshot> => {
  const futSymbol = `${symbol}:USDT`
  const mktFut = manager.market(futSymbol)!
  const contractSize = mktFut.contractSize ?? 1
  const minCt = mktFut.limits.amount?.min ?? 1

  let spotFilled = snapshot.spotOrder?.filled ?? 0
  let futureFilledCts = snapshot.futureOrder?.filled ?? 0
  let futureFilled = futureFilledCts * contractSize

  const redoSpot = prepareCreateOrder(
    manager,
    symbol,
    side === 'entry' ? 'buy' : 'sell'
  )
  const redoFuture = prepareCreateOrder(
    manager,
    futSymbol,
    side === 'entry' ? 'sell' : 'buy',
    /* reduceOnly */ true
  )

  if (side === 'entry') {
    const imbalance = futureFilled - spotFilled
    const imbalanceCts = Math.abs(imbalance) / contractSize

    if (imbalance > 0) {
      try {
        await redoSpot(undefined, imbalance)
      } catch (err) { }
      spotFilled += imbalance
    }
    else if (imbalanceCts >= minCt) {
      const qtyUnits = Math.abs(imbalance)
      const qtyContracts = qtyUnits / contractSize

      try {
        await redoFuture(undefined, qtyUnits)
      } catch (err) { }
      futureFilledCts += qtyContracts
      futureFilled += qtyUnits
    }
  }
  else {
    const spotRem = snapshot.spotOrder?.remaining ?? 0
    const futRemCts = snapshot.futureOrder?.remaining ?? 0

    if (spotRem > 0) {
      try {
        await redoSpot(undefined, spotRem)
      } catch (err) { }
      spotFilled += spotRem
    }

    if (futRemCts > 0) {
      const futRemUnits = futRemCts * contractSize

      try {
        await redoFuture(undefined, futRemUnits)
      } catch (err) { }
      futureFilledCts += futRemCts
      futureFilled += futRemUnits
    }
  }

  return {
    spotOrder: {
      filled: spotFilled,
      remaining: 0,
      symbol,
    } as Order,
    futureOrder: {
      filled: futureFilledCts,
      remaining: 0,
      symbol: futSymbol,
    } as Order,
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