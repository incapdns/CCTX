import Decimal from 'decimal.js';
import { ArbitrageDirection, ArbitrageOrder, ArbitrageRequest, ArbitrageResult, cleanResidual, findMaxPrice } from './common';

export const isOutsideTolerance = (base: Decimal.Value, target: Decimal.Value, percent: Decimal.Value): boolean => {
  const baseDecimal = Decimal(base);
  const targetDecimal = Decimal(target);
  const percentDecimal = Decimal(percent);

  const tolerance = baseDecimal.mul(percentDecimal).div(100);
  const lowerBound = baseDecimal.sub(tolerance);
  const upperBound = baseDecimal.add(tolerance);

  return targetDecimal.lt(lowerBound) || targetDecimal.gt(upperBound);
}

export const doEntryArbitrage = ({
  spotBook,
  futureBook,
  amount,
  marginQuantityPercent,
  percent
}: ArbitrageRequest<ArbitrageDirection.Entry>): ArbitrageResult<ArbitrageDirection.Entry> => {
  const spotOrders = spotBook.map(([price, qty]) => [Decimal(price), Decimal(qty)])
  const futureOrders = futureBook.map(([price, qty]) => [Decimal(price), Decimal(qty)])

  let i = 0, j = 0;

  let totalSpot = Decimal(0)
  let totalFuture = Decimal(0)

  let available = Decimal(amount)

  const spotOrderResults: ArbitrageOrder[] = []
  const futuresOrderResults: ArbitrageOrder[] = []

  let qty = Decimal(0)

  let completed = false

  while (
    i < spotBook.length &&
    j < futureBook.length &&
    cleanResidual(available).gt(0)
  ) {
    const spotPrice = spotOrders[i][0]
    const spotVolume = spotOrders[i][1]
    const futurePrice = futureOrders[j][0]
    const futureVolume = futureOrders[j][1]

    const diff = futurePrice
      .minus(spotPrice)
      .div(spotPrice)
      .mul(100)

    if (cleanResidual(diff).eq(0) || diff.lt(percent)) break;

    const maxQty = available.div(spotPrice)
    const currentQty = Decimal.min(maxQty, spotVolume, futureVolume)

    if (cleanResidual(currentQty).eq(0))
      break

    const value = spotPrice.mul(currentQty)
    totalSpot = totalSpot.plus(value)
    available = available.minus(currentQty)

    const spotOrder = spotOrderResults[spotOrderResults.length - 1]

    if (spotOrderResults.length &&
      spotVolume.gt(0) &&
      spotPrice.eq(spotOrder?.price)) {
      spotOrder.quantity =
        Decimal(spotOrder.quantity)
          .plus(currentQty)
          .toNumber()
    } else {
      spotOrderResults.push({
        price: spotPrice.toNumber(),
        quantity: currentQty.toNumber()
      })
    }

    totalFuture = totalFuture.plus(futurePrice.mul(currentQty))

    const futureOrder = futuresOrderResults[futuresOrderResults.length - 1]

    if (futuresOrderResults.length &&
      futureVolume.gt(0) &&
      futurePrice.eq(futureOrder?.price)) {
      futureOrder.quantity =
        Decimal(futureOrder.quantity)
          .plus(currentQty)
          .toNumber()
    } else {
      futuresOrderResults.push({
        price: futurePrice.toNumber(),
        quantity: currentQty.toNumber()
      })
    }

    spotOrders[i][1] = spotVolume.minus(currentQty)
    futureOrders[j][1] = futureVolume.minus(currentQty)

    if (cleanResidual(spotOrders[i][1]).eq(0))
      i++

    if (cleanResidual(futureOrders[j][1]).eq(0))
      j++

    qty = qty.plus(currentQty)

    completed =
      !isOutsideTolerance(amount, totalSpot, marginQuantityPercent) &&
      !isOutsideTolerance(amount, totalFuture, marginQuantityPercent)
  }

  const profit = totalFuture.minus(totalSpot)
  const profitPercent =
    totalSpot.gt(0) ?
      profit.div(totalSpot).mul(100) :
      Decimal(0)

  if (cleanResidual(qty).eq(0))
    return {
      completed: false,
      executed: 0,
      spotOrders: [],
      futureOrders: [],
      profitPercent: 0,
      maxPrice: {
        spot: 0,
        future: 0
      }
    }

  const maxPrice = findMaxPrice(spotBook, futureBook, percent)

  return {
    completed,
    executed: qty.toNumber(),
    spotOrders: spotOrderResults,
    futureOrders: futuresOrderResults,
    profitPercent: profitPercent.toNumber(),
    maxPrice: {
      spot: maxPrice?.increasing,
      future: maxPrice?.decreasing
    }
  }
}