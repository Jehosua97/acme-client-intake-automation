# Flujo conversacional con OpenAI

Esta rama contiene la primera versión activa de la interpretación conversacional con OpenAI.

## Objetivo

Después de que el administrador activa un expediente, la IA interpreta mensajes escritos de manera natural contra el campo pendiente. El catálogo y las validaciones deterministas conservan el control de lo que se guarda y de cuál pregunta sigue.

## Reglas de implementación

- Los comandos administrativos actuales siguen siendo la única forma de iniciar o detener el bot.
- El catálogo y la base SQLite siguen siendo la fuente de verdad para los datos requeridos.
- La IA propone datos estructurados; el sistema valida cada dato antes de guardarlo.
- Si una respuesta es ambigua, la IA debe pedir una aclaración y no inventar información.
- `STOP BOT`, la pausa global y la atención humana siempre tienen prioridad sobre la IA.
- Si OpenAI no responde, el expediente conserva su avance y el bot utiliza el motor normal como respaldo sin detener WhatsApp.
- Cada interpretación, aclaración, error y dato confirmado debe quedar registrado en la línea de tiempo.
- Los archivos y pasaportes no se envían a OpenAI en esta versión; se mantiene el procesamiento existente.

## Configuración local

Copia las variables vacías de `.env.example` al archivo local `.env`:

```dotenv
OPENAI_API_KEY=
OPENAI_MODEL=gpt-5.4-mini
AI_CONVERSATION_ENABLED=true
```

La clave real se colocará después de `OPENAI_API_KEY=` únicamente en `.env`. Este archivo está excluido de Git y no debe compartirse por chat, capturas de pantalla ni commits.

Para comprobar la conexión sin usar datos reales de clientes:

```powershell
npm run ai:check
```
