# Decisiones de esta primera fase

## Confirmadas

- WhatsApp: `whatsapp-web.js`, sin Meta Cloud API.
- Persistencia: SQLite local en vez de JSON. Sigue siendo un solo archivo, pero ofrece transacciones, índices y respaldos consistentes.
- Documentos: Google Drive, una carpeta creada automáticamente por cliente.
- Extracción del pasaporte: manual desde el panel; no se usa OCR ni inteligencia artificial.
- Ejecución: directamente en Windows con Node.js, sin Docker.
- Activación: el bot empieza únicamente cuando el dueño envía `INICIAR BOT` en el chat individual del cliente.
- Alcance de preguntas: datos personales, familia, residencia, contacto, idiomas, educación, empleo y viaje. Se excluyen las categorías sensibles indicadas para esta fase.
- Acceso administrativo: interfaz local, no publicada en Internet.

## Para una fase posterior

- Definir política formal de retención, exportación y eliminación de expedientes.
- Añadir usuarios, contraseñas, MFA y roles si el panel se usará desde más de una computadora.
- Incorporar extracción de pasaporte solo si se define un proceso de revisión, privacidad y consentimiento adecuado.
- Añadir recordatorios programados y reglas para evitar mensajes excesivos.
- Evaluar una API oficial si la estabilidad o las políticas de WhatsApp se vuelven un riesgo operativo.
- Definir un mecanismo de archivo/cierre y una papelera recuperable para expedientes.
