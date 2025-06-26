import { pro as ccxt } from 'ccxt';
import { doArbitrage } from './arbitrage/compute';
import { ArbitrageDirection } from './arbitrage/compute/common';
import config from './config.json';
import { addAccount, appendExchange, getExchange } from './exchange';
import { fixMexc, prepareFix } from './fixes/mexc';
import { prepareCreateOrder } from './arbitrage/run/common';
import { rejectTimeout } from './arbitrage/run/steps/common';

prepareFix()

const mexc = config.exchanges.mexc

const defaultMexcExchange = fixMexc(new ccxt.mexc(mexc), mexc.webToken)

addAccount(0)

appendExchange(0, defaultMexcExchange)

const test = async () => {
  const timeout = rejectTimeout<void>(1000)
  while(true) {
    const res = await Promise.race([
      timeout.promise,
      []
    ])

    await new Promise(resolve => setTimeout(resolve, 500))

    console.log({ res })
  }
}

test()