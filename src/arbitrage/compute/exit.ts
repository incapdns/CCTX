import Decimal from 'decimal.js';
import { ArbitrageDirection, ArbitrageOrder, ArbitrageRequest, ArbitrageResult, cleanResidual, findMaxPrice } from './common';

export const doExitArbitrage = ({ 
  spotOrders, 
  futureOrders, 
  executed, 
  percent,
  contractSize
}: ArbitrageRequest<ArbitrageDirection.Exit>): ArbitrageResult<ArbitrageDirection.Exit> => {
  const spotOrdersClone = spotOrders.map(([price, qty]) => [Decimal(price), Decimal(qty)])
  const futureOrdersClone = futureOrders.map(([price, qty]) => [Decimal(price), Decimal(qty)])

  let i = 0, j = 0;

  const spotOrderResults: ArbitrageOrder[] = []
  const futuresOrderResults: ArbitrageOrder[] = []

  let available = Decimal(executed)

  while (
    i < spotOrders.length &&
    j < futureOrders.length &&
    cleanResidual(available).gt(0)
  ) {
    const spotPrice = spotOrdersClone[i][0]
    const spotVolume = spotOrdersClone[i][1]
    const futurePrice = futureOrdersClone[j][0]
    const futureVolume = futureOrdersClone[j][1].mul(contractSize)

    const diff = spotPrice
      .minus(futurePrice)
      .div(futurePrice)
      .mul(100)

    if (diff.lt(percent)) break;

    const qty = Decimal.min(available, spotVolume, futureVolume)
    available = available.minus(qty)

    const spotOrder = spotOrderResults[spotOrderResults.length - 1]

    if (spotOrderResults.length &&
      spotVolume.gt(0) &&
      spotPrice.eq(spotOrder?.price)) {
      spotOrder.quantity =
        Decimal(spotOrder.quantity)
          .plus(qty)
          .toNumber()
    } else {
      spotOrderResults.push({
        price: spotPrice.toNumber(),
        quantity: qty.toNumber()
      })
    }

    const futureOrder = futuresOrderResults[futuresOrderResults.length - 1]

    if (futuresOrderResults.length &&
      futureVolume.gt(0) &&
      futurePrice.eq(futureOrder?.price)) {
      futureOrder.quantity =
        Decimal(futureOrder.quantity)
          .plus(qty)
          .toNumber()
    } else {
      futuresOrderResults.push({
        price: futurePrice.toNumber(),
        quantity: qty.toNumber()
      })
    }

    if (qty.gt(0)) {
      spotOrdersClone[i][1] = spotVolume.minus(qty)
      futureOrdersClone[j][1] = futureVolume.minus(qty)
    }

    if (cleanResidual(spotOrdersClone[i][1]).eq(0))
      i++

    if (cleanResidual(futureOrdersClone[j][1]).eq(0))
      j++
  }

  const completed = cleanResidual(available).eq(0)

  const maxPrice = findMaxPrice(futureOrders, spotOrders, percent)

  return {
    completed,
    executed: executed - cleanResidual(available).toNumber(),
    spotOrders: spotOrderResults,
    futureOrders: futuresOrderResults,
    maxPrice: {
      spot: maxPrice?.decreasing,
      future: maxPrice?.increasing
    }
  }
}