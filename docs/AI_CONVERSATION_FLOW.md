# Flujo conversacional con OpenAI

Esta rama prepara la siguiente etapa del bot. La integración todavía no está activa.

## Objetivo

Después de que el administrador active un expediente, la IA podrá interpretar mensajes escritos de manera natural, comparar lo recibido con los campos pendientes y mantener una conversación fluida sin perder el orden ni las validaciones del formulario.

## Reglas de implementación

- Los comandos administrativos actuales siguen siendo la única forma de iniciar o detener el bot.
- El catálogo y la base SQLite siguen siendo la fuente de verdad para los datos requeridos.
- La IA propone datos estructurados; el sistema valida cada dato antes de guardarlo.
- Si una respuesta es ambigua, la IA debe pedir una aclaración y no inventar información.
- `STOP BOT`, la pausa global y la atención humana siempre tienen prioridad sobre la IA.
- Si OpenAI no responde, el expediente conserva su avance y el bot utiliza una respuesta segura sin duplicar mensajes.
- Cada interpretación, aclaración, error y dato confirmado debe quedar registrado en la línea de tiempo.

## Configuración local

Copia las variables vacías de `.env.example` al archivo local `.env`:

```dotenv
OPENAI_API_KEY=
OPENAI_MODEL=
AI_CONVERSATION_ENABLED=false
```

La clave real se colocará después de `OPENAI_API_KEY=` únicamente en `.env`. Este archivo está excluido de Git y no debe compartirse por chat, capturas de pantalla ni commits.
