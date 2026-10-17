const HOST = process.env.OLLAMA_HOST ?? 'http://127.0.0.1:11434';
export const MODEL = process.env.OLLAMA_MODEL ?? 'qwen2.5:3b';

export async function chat(messages) {
  const res = await fetch(`${HOST}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: MODEL, messages, stream: false }),
  });
  if (!res.ok) throw new Error(`Ollama ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.message.content;
}
