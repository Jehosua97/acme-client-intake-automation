# Arquitectura del MVP local

## Flujo principal

```text
Dueño escribe INICIAR BOT en un chat individual
                         │
                         ▼
               whatsapp-web.js
                         │
                 motor de estados
                         │
             ┌───────────┴───────────┐
             ▼                       ▼
      respuestas de texto       foto o PDF
             │                       │
             ▼                       ▼
       motor de estados       cola persistente
             │                       │
             └───────────┬───────────┘
                         ▼
                      SQLite
                         │
             ┌───────────┴───────────┐
             ▼                       ▼
        panel local          Google Drive API
             │                       │
             ▼                carpeta del cliente
     PDF local en memoria
             │
             ▼
         Gmail API
```

## Componentes

- `src/domain`: catálogo de preguntas, validación, campos condicionales, progreso, pausa y reanudación.
- `src/infrastructure/sqlite-store.ts`: persistencia transaccional, historial, idempotencia y cola de documentos.
- `src/infrastructure/whatsapp-local.ts`: sesión local, regla de activación, exclusión de grupos, recepción y envío.
- `src/infrastructure/google-drive.ts`: OAuth, carpeta raíz, carga de documentos y envío por Gmail.
- `src/infrastructure/client-pdf.ts`: resumen PDF compacto generado completamente en memoria.
- `src/infrastructure/encrypted-token-store.ts`: cifrado autenticado del token de Google.
- `src/server.ts`: API local y servidor del panel.
- `public`: interfaz de expedientes.

## Estados del expediente

```text
DRAFT → INVITED → AWAITING_CONSENT → ACTIVE
                                      ├─ PAUSED
                                      ├─ WAITING_FOR_CLIENT
                                      ├─ NEEDS_STAFF_REVIEW
                                      └─ READY_FOR_REVIEW → COMPLETE

AWAITING_CONSENT → DECLINED
cualquier etapa → DELETION_REQUESTED
```

Cada respuesta también tiene estado independiente:

- `CONFIRMED`: confirmada por cliente o personal.
- `PENDING`: saltada o pendiente de captura manual desde el pasaporte.
- `PROPOSED`: reservado para una fase futura; no hay extracción automática en este MVP.
- `CONFLICT`: requiere revisión humana.

## Recepción de documentos

El manejador de mensajes no bloquea la conversación mientras sube un archivo. Primero crea un trabajo en `pending_documents`; un worker local recupera el mensaje, valida formato y tamaño, y lo carga a Drive. Si Drive no está disponible, el trabajo regresa a pendiente con espera incremental. Al reiniciar la aplicación, cualquier trabajo interrumpido vuelve a la cola.

Se aceptan `application/pdf`, `image/jpeg`, `image/png` e `image/webp`, con un límite configurable de 20 MB. El archivo no se conserva permanentemente en el disco local: se decodifica en memoria, se carga a Drive y en SQLite solo queda su identificador y enlace.

## Reglas de conversación

- Un mensaje entrante sin expediente conocido se marca procesado y no recibe respuesta.
- El comando de activación solo se procesa si `fromMe` es verdadero y el chat no es grupo.
- Los mensajes de estado, difusión y grupos son ignorados.
- El identificador de cada mensaje se almacena para impedir procesamiento duplicado.
- Después del pasaporte se pide el nombre completo para identificar el expediente; los demás campos visibles en ese documento quedan pendientes de revisión humana.
- El estado y la pregunta actual se guardan después de cada turno.

## Seguridad local

- El servidor rechaza configuraciones que intenten escuchar fuera de loopback.
- Las consultas usan parámetros; no concatenan entradas del cliente en SQL.
- SQLite usa WAL, claves foráneas y `busy_timeout`.
- El token de Google se cifra con AES-256-GCM y una clave que vive en `.env`.
- La sesión de WhatsApp y la base quedan excluidas de control de versiones.
- Drive usa `drive.file`, limitado a archivos y carpetas creados o abiertos por esta aplicación.
- El correo usa únicamente `gmail.send`; no se solicitan permisos para leer, modificar ni eliminar correos.
- El PDF se crea en memoria y no contiene las notas internas del expediente.

## Respaldo y recuperación

El botón de respaldo utiliza la API de backup de SQLite, por lo que genera una copia consistente aun con la aplicación abierta. Para una recuperación completa conviene respaldar también `.env`, `whatsapp-session` y `google-token.enc` en un medio cifrado. El contenido de los pasaportes permanece en Google Drive.
