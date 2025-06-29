import Decimal from 'decimal.js'

export enum ArbitrageDirection {
  Entry,
  Exit
}

export interface ArbitrageOrder {
  price: number
  quantity: number
}

export interface CommonResult {
  spotOrders: ArbitrageOrder[]
  futureOrders: ArbitrageOrder[]
  maxPrice: {
    spot: number;
    future: number;
  }
  executed: number;
  completed: boolean;
}

export type ArbitrageResults = {
  [ArbitrageDirection.Entry]: CommonResult & {
    profitPercent: number
  }
  [ArbitrageDirection.Exit]: CommonResult;
}

export type ArbitrageResult<Direction extends ArbitrageDirection> = ArbitrageResults[Direction]

export const cleanResidual = (value: Decimal, epsilon = new Decimal('1e-12')): Decimal =>
  value.abs().lt(epsilon) ? new Decimal(0) : value

export interface CommonRequest {
  spotBook: [number, number][]
  futureBook: [number, number][]
  percent: number
  contractSize: number
}

export type ArbitrageRequests = {
  [ArbitrageDirection.Entry]: CommonRequest & {
    amount: number,
    marginQuantityPercent: number
  },
  [ArbitrageDirection.Exit]: CommonRequest & {
    executed: number
  }
}

export type ArbitrageRequest<Direction extends ArbitrageDirection> = {
  direction: Direction
} & ArbitrageRequests[Direction]

type DataPoint = [number, number];

export const findMaxPrice = (
  increasing: DataPoint[],
  decreasing: DataPoint[],
  percentage: number
): { increasing: number; decreasing: number } | null => {
  let best: { increasing: number; decreasing: number } | null = null;
  let minExcess = Infinity;

  let j = decreasing.length - 1;

  let i = 0;
  while (i < increasing.length && j >= 0) {
    const increasingPrice = increasing[i][0];
    const required = increasingPrice * (1 + percentage / 100);

    while (j >= 0 && decreasing[j][0] < required) {
      j--;
    }

    if (j < 0) break;

    const decreasingPrice = decreasing[j][0];
    const diffPercentage = ((decreasingPrice - increasingPrice) / increasingPrice) * 100;
    const excess = diffPercentage - percentage;

    if (excess < minExcess) {
      minExcess = excess;
      best = {
        increasing: increasingPrice, 
        decreasing: decreasingPrice
      }
    }
    i++;
  }

  return best;
}