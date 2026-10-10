/** 본문을 읽으면서 상한을 강제한다 — Content-Length를 속이거나 생략해도 상한 너머는 메모리에 담지 않는다. */
export async function readLimited(req: Request, max: number): Promise<Uint8Array<ArrayBuffer> | 'too_large'> {
  const declared = Number(req.headers.get('Content-Length'));
  if (Number.isFinite(declared) && declared > max) return 'too_large';
  if (!req.body) return new Uint8Array(0);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      return 'too_large';
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}
