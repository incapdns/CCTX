type ArrayType<Arr> = Arr extends (infer T)[] ? T : never

export const flattenPromises = async <P extends Promise<any[]>>(promises: P[]): Promise<ArrayType<Awaited<P>>[]> => {
  const final: ArrayType<Awaited<P>>[] = []

  const results = await Promise.all(promises)
  
  for(const result of results)
    final.push(...result)

  return final
}

if (!Object.groupBy) {
  Object.groupBy = function <T extends any[]>(array: T, callback) {
    return array.reduce((acc, item) => {
      const key = callback(item);
      (acc[key] ||= []).push(item);
      return acc;
    }, {});
  };
}