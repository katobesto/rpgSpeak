// Normalización de mensajes para backends locales que aplican la plantilla
// chat de HuggingFace del modelo (Ollama, LM Studio, llama.cpp vía custom,
// MLX, Oobabooga).
//
// El motor de conversación inyecta el estado del turno como ~15 mensajes
// SYSTEM al final del prompt (footer). Eso solo es válido en APIs que
// aceptan system en cualquier posición (OpenAI, OpenRouter). Las plantillas
// de los modelos locales no:
//   · Gemma 4 renderiza UN solo turno system, tomado de messages[0]; los
//     system de en medio salen de distribución (turnos <|turn>system
//     sueltos) y el modelo deja de obedecer el estado del turno.
//   · Muchas plantillas exigen alternancia estricta user/model.
// Resultado observado: en cuanto la conversación crece, el modelo deja de
// ver el presente (ubicación, hilos, afinidad, dados) y la historia se
// desmorona — sin ningún error visible.
//
// La normalización mantiene el primer system en cabecera (prefijo cacheable)
// y adjunta los systems tardíos al siguiente mensaje de usuario EN SU
// POSICIÓN — nunca a la cabecera: subir el estado cambiante invalidaría el
// prefix-cache en cada turno.
export function normalizeStrictTemplateMessages(
  messages: { role: string; content: string }[],
): { role: string; content: string }[] {
  const result: { role: string; content: string }[] = [];
  const pending: string[] = [];
  for (const msg of messages) {
    if (msg.role === 'system') {
      if (result.length === 0 || (result.length === 1 && result[0].role === 'system')) {
        if (result.length === 0) result.push({ ...msg });
        else result[0].content += `\n\n${msg.content}`;
      } else {
        pending.push(msg.content);
      }
      continue;
    }
    if (pending.length && msg.role === 'assistant') {
      const last = result[result.length - 1];
      if (last?.role === 'user') last.content += `\n\n${pending.join('\n\n')}`;
      else result.push({ role: 'user', content: pending.join('\n\n') });
      pending.length = 0;
    }
    const content = pending.length ? `${pending.join('\n\n')}\n\n${msg.content}` : msg.content;
    pending.length = 0;
    const previous = result[result.length - 1];
    if (msg.role === 'assistant' && (!previous || previous.role === 'system')) {
      result.push({ role: 'user', content: 'Continúa la conversación.' });
    }
    if (previous?.role === msg.role) previous.content += `\n\n${content}`;
    else result.push({ role: msg.role, content });
  }
  if (pending.length) {
    const last = result[result.length - 1];
    if (last?.role === 'user') last.content += `\n\n${pending.join('\n\n')}`;
    else result.push({ role: 'user', content: pending.join('\n\n') });
  }
  return result;
}
