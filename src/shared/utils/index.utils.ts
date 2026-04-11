export function safeStringify(obj: any): string {
  try {
    return JSON.stringify(obj);
  } catch (error) {
    return `[Object - Cannot stringify: ${error.message}]`;
  }
}

export function stringLogLimit(str: string, limit = 1000): string {
  return str.length > limit ? `${str.slice(0, limit)}...` : str;
}
