/**
 * The first `maxLength` UTF-16 units of `text`, one fewer when the cut would
 * split a surrogate pair (an emoji, a rarer CJK character): a lone half is not
 * valid text, and a strict JSON parser (llama-server's) rejects a request
 * carrying one.
 */
export function sliceUtf16(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }
  if (maxLength <= 0) {
    return "";
  }
  const last = text.charCodeAt(maxLength - 1);
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? maxLength - 1 : maxLength);
}
