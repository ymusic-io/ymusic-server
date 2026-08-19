/** Node hands a repeated header over as an array; a client sending one twice gets the first. */
export function header(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}
