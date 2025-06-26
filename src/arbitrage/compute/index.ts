import { ArbitrageDirection, ArbitrageRequest, ArbitrageResult } from "./common";
import { doEntryArbitrage } from "./entry";
import { doExitArbitrage } from "./exit";

export const doArbitrage = <Direction extends ArbitrageDirection>(request: ArbitrageRequest<Direction>): ArbitrageResult<Direction> => {
  const result = request.direction == ArbitrageDirection.Entry ?
    doEntryArbitrage(request as ArbitrageRequest<ArbitrageDirection.Entry>) :
    doExitArbitrage(request as ArbitrageRequest<ArbitrageDirection.Exit>)

  return result as ArbitrageResult<Direction>
}