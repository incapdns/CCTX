import { Exchange as CcxtExchange, Order } from "ccxt"
import EventEmitter from "node:events"
import TypedEmitter from "typed-emitter"
import './helper'

interface ExchangeEvents {
  order: (order: Order[]) => void
  [key: `orderOfSymbol:${string}`]: (order: Order[]) => void
  [key: string]: (...args: any[]) => void
}

interface Connect {
  promise: Promise<void>,
  resolve: () => void,
}

export class Exchange extends (EventEmitter as new () => TypedEmitter<ExchangeEvents>) {
  private accountId: number
  private manager: CcxtExchange
  private live: boolean
  private connect: Connect
  public running: string[]

  public constructor(accountId: number, manager: CcxtExchange) {
    super()

    this.accountId = accountId
    this.manager = manager
    this.running = []
    this.live = true
    this.watchOrders()
  }

  private prepareOnConnect() {
    let resolver;
    this.connect = {
      resolve() { },
      promise: new Promise<void>(resolve => resolver = resolve)
    }
    this.connect.resolve = resolver

    let urls: string[] = []

    const onConnected = ({ url }) => {
      urls.push(url)

      const connected = ['contract.mexc.com', 'wbs.mexc.com'].every(base => urls.find(u => u.includes(base)))

      if (connected && this.manager.onConnected == onConnected)
        this.manager.onConnected = () => { }

      if (connected)
        this.connect.resolve()
    }

    this.manager.onConnected = onConnected
  }

  private watch(orderType: string) {
    const emitOrders = (orders: Order[]) => {
      const groups = Object.groupBy(orders, order => order.symbol)

      for (const [symbol, orders] of Object.entries(groups))
        this.emit(`orderOfSymbol:${symbol}`, orders)

      this.emit('order', orders)
    }

    const timeWithRetry = async () => {
      while (true) {
        try {
          const time = await this.manager.fetchTime()
          return time
        } catch (err) { }
      }
    }

    setImmediate(async () => {
      const serverTime = await timeWithRetry()
      const localTime = Date.now()
      const offset = serverTime - localTime

      let lastTime = Date.now()

      while (this.live) {
        try {
          const orders = await this.manager.watchOrders(undefined, undefined, undefined, { type: orderType })
          emitOrders(orders)
          lastTime = Date.now()
        } catch (err) {
          const backupTime = lastTime + offset - 60000
          this.running.forEach(async symbol => {
            while (true) {
              try {
                const pendingOrders = await this.manager.fetchOrders(symbol, backupTime, 100)
                return emitOrders(pendingOrders)
              } catch (error) {
                console.error({ error })
              }
            }
          })
        }
      }
    })
  }

  private watchOrders() {
    this.prepareOnConnect()

    this.watch('swap')
    this.watch('spot')
  }

  public async waitConnect() {
    await this.connect.promise
  }

  public getAccountId() {
    return this.accountId
  }

  public getManager() {
    return this.manager
  }

  public getId() {
    return this.manager.id
  }

  public destroy() {
    this.live = false
    return this
  }
}

type Exchanges = Map<number, Map<string, Exchange>>

const accounts: Exchanges = new Map()

export const addAccount = (accountId: number) =>
  accounts.set(accountId, new Map())

export const getAccount = (accountId: number) =>
  accounts.get(accountId)

export const removeAccount = (accountId: number) => {
  const account = accounts.get(accountId)
  for (const exchange of account.values()) {
    accounts.delete(accountId)
    exchange.destroy()
  }
}

export const appendExchange = (accountId: number, manager: CcxtExchange) =>
  accounts
    .get(accountId)
    .set(manager.id, new Exchange(accountId, manager))

export const getExchange = (accountId: number, exchangeId: string) =>
  accounts
    .get(accountId)
    .get(exchangeId)

export const removeExchange = (exchange: Exchange) => {
  const accountId = exchange.getAccountId()
  exchange.destroy()
  const acccount = accounts.get(accountId)
  acccount.delete(exchange.getId())
}