export async function readAll(stream) {
  if (!stream) return '';
  let data = '';
  for await (const chunk of stream) data += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
  return data;
}
