import { pro as ccxt } from 'ccxt';
import http from 'http';
import { runArbitrage } from './arbitrage/run/run';
import config from './config.json';
import { addAccount, appendExchange, getExchange } from './exchange';
import { fixMexc, prepareFix } from './fixes/mexc';

prepareFix()

const mexc = config.exchanges.mexc

const defaultMexcExchange = fixMexc(new ccxt.mexc(mexc), mexc.webToken)

addAccount(0)

appendExchange(0, defaultMexcExchange)

const server = http.createServer((req, res) => {
  const url = new URL(`http://localhost/${req.url}`)

  const symbol = url.searchParams.get('symbol')
  if (!symbol?.length)
    return res.end('Invalid symbol')

  const resume = url.searchParams.get('resume')
  const amount = Number(url.searchParams.get('amount'))

  if(!(amount > 0) && !resume)
    return res.end('Invalid amount')

  runArbitrage({
    symbol,
    exchange: getExchange(0, 'mexc'),
    amount,
    timeout: 10000,
    resume
  })

  res.end('Ok')
})

server.listen(1000)