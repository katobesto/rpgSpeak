# Revisión del motor de conversaciones

Base revisada: `880e04d`, sincronizada desde `origin/main` el 7 de noviembre de 2026.

## Cambios

- La temperatura global admite de **0 a 2**, con paso **0,01**, además de los tres botones de selección rápida. Los valores de 0 y menores de 0,4 llegan al proveedor sin sustituirse por un valor por defecto.
- Se separan **repetición multiplicativa** (`generationRepetitionPenalty`, nuevo valor por defecto 1,1), **frecuencia** y **presencia**. Antes, el motor reutilizaba `generationFrequencyPenalty` como `repetitionPenalty`: un 0 neutro para frecuencia llegaba como un 0 multiplicativo a Ollama o Kobold.
- La API valida los límites antes de guardar los ajustes. Las preferencias de temperatura, frecuencia y presencia ya guardadas se conservan.
- LM Studio conserva el mensaje de sistema inicial y el historial en su posición. Los bloques de sistema intermedios se incorporan al mensaje de usuario correspondiente; ya no se suben los datos dinámicos de escena y afinidad al principio de cada petición. Se mantiene la alternancia de roles que requieren las plantillas estrictas.
- Los proveedores compatibles reciben una petición explícita de estadísticas durante el streaming. OpenRouter recibe `provider.allow_fallbacks` en el objeto correcto.
- Las ventanas pequeñas conservan el mensaje actual; el recorte evita comenzar por una respuesta sin su pregunta. El prefijo con ejemplos de voz y el footer obligatorio se protegen explícitamente. Las correcciones del turno se incluyen antes de calcular el presupuesto.
- El resumen se actualiza también cuando se descarta historial por tokens, y no solo por número de mensajes. Si el resumen añadido obliga a retirar más historial, se repite el ajuste hasta encajar. Se mantienen los resúmenes personales en modo personaje con grupo, sin sustituirlos por los globales.
- Si el contenido obligatorio por sí solo excede el presupuesto estimado, se devuelve un error que indica cómo corregirlo, en lugar de enviar un prompt excesivo al proveedor.

## Prompts

Los seis prompts de serie pasan de **35.171 a 5.774 caracteres** en conjunto (aproximadamente un 84 % menos). Son plantillas alternativas y complementarias: no se inyectan las seis completas en todos los modos.

Se retiran listas repetidas de prohibiciones, ejemplos duplicados y reglas contradictorias sobre dudas y decisiones. Se conservan las responsabilidades de cada bloque: principios generales, formato del personaje, narración, coherencia, conocimiento individual y afinidad. Los bloques generados por código de identidad, gestos, intimidad y escena también se condensan. La tabla estable de afinidad pasa al prefijo; los valores actuales siguen al final.

Las copias exactas de los antiguos valores de serie se reconocen por SHA-256, normalizando CRLF a LF. Al leer los ajustes se usa su versión compacta, sin modificar el texto almacenado. Los textos personalizados, incluido un campo vacío, se respetan. Para adoptar una plantilla nueva sobre un texto personalizado se puede usar el control de restaurar valor por defecto de Ajustes.

El detector de variedad solo añade un aviso cuando encuentra frases o aperturas repetidas de la misma voz. Excluye la cabecera ambiental y las intervenciones de otras voces; ya no añade un aviso por el mero hecho de tener dos respuestas anteriores distintas.

## Compatibilidad de penalizaciones

| Proveedor | Repetición multiplicativa | Frecuencia / presencia |
| --- | --- | --- |
| Ollama | `options.repeat_penalty` | `options.frequency_penalty` / `options.presence_penalty` |
| Kobold | `rep_pen` | No se envían |
| LM Studio | `repeat_penalty` | `frequency_penalty` / `presence_penalty` |
| MLX, Oobabooga | `repetition_penalty` | `frequency_penalty` / `presence_penalty` |
| OpenRouter | `repetition_penalty`, según modelo y endpoint | Según modelo y endpoint |
| OpenAI, Custom | No se envía el campo no estándar | `frequency_penalty` / `presence_penalty`, según modelo |

Repetición **1** es neutra; valores como **1,05–1,15** permiten un ajuste moderado. Frecuencia y presencia **0** son neutras. No se convierten unas escalas en otras. Una temperatura baja aumenta la predictibilidad; por sí sola no garantiza menos repeticiones.

El soporte con razonamiento depende del backend. Se conservan los controles de muestreo para Qwen y otros modelos locales compatibles cuando se activa thinking. Se siguen omitiendo en las peticiones de razonamiento OpenAI/DeepSeek tratadas por el adaptador como incompatibles.

Referencias de los adaptadores: [LM Studio](https://lmstudio.ai/docs/developer/openai-compat/chat-completions), [OpenRouter](https://openrouter.ai/docs/api_reference/parameters), [opciones de Ollama](https://github.com/ollama/ollama/blob/main/api/types.go), [servidor MLX](https://github.com/ml-explore/mlx-lm/blob/main/mlx_lm/server.py).

## Caché y comprobaciones

El orden favorece un prefijo estable: reglas y lore, fichas y ejemplos, historial, datos del turno, mensaje actual. Los cortes de historial siguen avanzando a saltos. El cambio de modelo, modo, ficha, lore, ejemplos o ventana puede invalidar parte del prefijo. La normalización de LM Studio ya no lo invalida por un cambio de afinidad o ubicación.

El servidor de inferencia decide si conserva y reutiliza la KV cache. Las llamadas auxiliares al mismo modelo pueden competir por ella según su implementación. Se mantienen los controles existentes de árbitro, actualización del mundo, director, resúmenes e índice; esta revisión no modifica las preferencias guardadas de esas funciones.

Verificación automatizada: `npm run test -w server`, con HTTP simulado y SQLite en memoria. Cubre streaming y generación normal, escalas independientes, temperatura 0, alternancia de LM Studio, prefijos estables, aislamiento de escenas privadas, ventanas pequeñas, resúmenes tras recorte por tokens y validación de ajustes.

La compilación completa pasa. El lint general y la comprobación TypeScript independiente del cliente tienen errores previos en el repositorio; la comparación de diagnósticos con `880e04d` no detecta errores nuevos en los archivos modificados. No se ha medido latencia ni calidad narrativa contra un modelo real. El presupuesto sigue usando la heurística existente de cuatro caracteres por token; no es una medida exacta del tokenizador de cada modelo.
