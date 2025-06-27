import { browserHeaders } from './browserHeaders';
import { fetch } from './fetch';
export const symbolsUrl = 'https://www.mexc.com/api/platform/spot/market-v2/web/symbolsV2'

export interface Item {
  id: string;
}

export interface Symbols {
  [name: string]: {
    id: string;
    itens: Map<string, Item>
  }
}

const symbols: Symbols = {}

fetch(symbolsUrl, { headers: browserHeaders })
  .then(res => res.json() as any)
  .then(({ data }) => {
    for (let [name, itens] of <any>Object.entries(data.symbols)) {
      const map = new Map<string, Item>()

      for (let item of itens)
        map.set(item.vn, { id: item.cd })

      symbols[name] = {
        id: itens[0].mcd,
        itens: map
      }
    }
  })

export const getSymbols = () => symbols